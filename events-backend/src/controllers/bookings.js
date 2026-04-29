const prisma = require('../db');
const walletService = require('../services/wallet');

function generateBookingId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BK-${today}-${rand}`;
}

function generateTicketId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TK-${today}-${rand}`;
}

function generateTicketCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `TD-${rand(2)}${rand(4)}${rand(2)}`;
}

const TX_OPTIONS = { timeout: 30000 };

// Map seat category → tier name for price lookup
const CATEGORY_TO_TIER = { regular: 'Regular', premium: 'VIP', balcony: 'Balcony' };

async function createBooking(req, res, next) {
  try {
    const { event_id, tier_id, quantity, attendee_names, payment_method, seat_ids, screening_id } = req.body;
    const userId = BigInt(req.user.id);

    if (!payment_method) {
      return res.status(400).json({ success: false, message: 'payment_method is required' });
    }

    // ── Seat-based booking (cinema with screening + seat map) ─────────────────
    if (seat_ids?.length && screening_id) {
      const result = await prisma.$transaction(async (tx) => {
        // Verify screening exists and get event_id from it
        const screening = await tx.event_screenings.findUnique({
          where: { id: screening_id },
          select: { id: true, event_id: true, hall_id: true, show_date: true, show_time: true, status: true },
        });
        if (!screening) {
          const err = new Error('Screening not found'); err.status = 404; throw err;
        }
        if (screening.status === 'cancelled') {
          const err = new Error('This screening has been cancelled'); err.status = 409; throw err;
        }
        const resolvedEventId = screening.event_id;

        // 1. Verify user has active holds on ALL requested event_seats
        const holds = await tx.event_seat_holds.findMany({
          where: {
            screening_id,
            seat_id: { in: seat_ids },
            user_id: userId,
            expires_at: { gt: new Date() },
          },
        });

        if (holds.length !== seat_ids.length) {
          const err = new Error('Seat hold expired or not found. Please select your event_seats again.');
          err.status = 409; throw err;
        }

        // 2. Double-check none are already booked for THIS screening (race condition guard)
        const alreadyBooked = await tx.event_booking_seats.findMany({
          where: { screening_id, seat_id: { in: seat_ids } },
          include: { event_bookings: { select: { status: true } } },
        });
        if (alreadyBooked.some((b) => b.event_bookings.status === 'confirmed')) {
          const err = new Error('One or more event_seats were just booked by someone else.');
          err.status = 409; throw err;
        }

        // 3. Fetch seat details to compute price per category
        const event_seats = await tx.event_seats.findMany({
          where: { id: { in: seat_ids } },
          select: { id: true, row_label: true, seat_number: true, category: true, section: true },
        });

        // 4. Look up tier prices for each category present
        const tiers = await tx.event_ticket_tiers.findMany({ where: { event_id: resolvedEventId } });
        const tierByName = new Map(tiers.map((t) => [t.name.toLowerCase(), t]));

        let totalAmount = 0;
        const seatDetails = event_seats.map((seat) => {
          const tierName = CATEGORY_TO_TIER[seat.category] || 'Regular';
          const tier = tierByName.get(tierName.toLowerCase()) || tiers[0];
          totalAmount += tier.price;
          return { ...seat, tier_id: tier.id, tier_name: tier.name, price: tier.price };
        });

        const primaryTier = seatDetails[0];

        // 5. Fetch event info
        const event = await tx.events.findUnique({
          where: { id: resolvedEventId },
          select: { title: true, venue_name: true },
        });

        // 6. Process wallet payment if applicable
        const journalCode = walletService.generateJournalCode();
        if (payment_method === 'WALLET') {
          await walletService.debitWallet(
            tx, userId, totalAmount, journalCode,
            `Event booking: ${event.title} — ${seat_ids.length} seat(s)`
          );
        }

        // 7. Create booking row
        const bookingId = generateBookingId();
        const ticketCode = generateTicketCode();
        const ticketId = generateTicketId();

        await tx.event_bookings.create({
          data: {
            id: bookingId,
            ticket_code: ticketCode,
            user_id: userId,
            event_id: resolvedEventId,
            screening_id,
            tier_id: primaryTier.tier_id,
            quantity: seat_ids.length,
            total_amount: totalAmount,
            payment_method,
            attendee_names: JSON.stringify(attendee_names || []),
            status: 'confirmed',
            payment_status: payment_method === 'WALLET' ? 'paid' : 'pending',
            wallet_journal_code: payment_method === 'WALLET' ? journalCode : null,
          },
        });

        // 7. Insert event_booking_seats with screening_id — marks each seat as booked for this show
        await tx.event_booking_seats.createMany({
          data: seat_ids.map((seat_id) => ({
            booking_id: bookingId,
            seat_id,
            event_id: resolvedEventId,
            screening_id,
          })),
        });

        // 8. Decrement available_seats per tier used
        const tierDecrements = seatDetails.reduce((acc, s) => {
          acc[s.tier_id] = (acc[s.tier_id] || 0) + 1;
          return acc;
        }, {});
        await Promise.all(
          Object.entries(tierDecrements).map(([tid, count]) =>
            tx.event_ticket_tiers.update({
              where: { id: tid },
              data: { available_seats: { decrement: count } },
            })
          )
        );

        // 9. Release holds — confirmed, no longer needed
        await tx.event_seat_holds.deleteMany({ where: { screening_id, user_id: userId } });

        return {
          booking_id: bookingId,
          ticket_id: ticketId,
          ticket_code: ticketCode,
          event_id: resolvedEventId,
          screening_id,
          screening_date: screening.show_date.toISOString().slice(0, 10),
          screening_time: screening.show_time.toISOString().slice(11, 16),
          event_title: event.title,
          quantity: seat_ids.length,
          total_amount: totalAmount,
          payment_method,
          attendee_names: attendee_names || [],
          venue_name: event.venue_name,
          event_seats: seatDetails.map((s) => ({
            seat_id: s.id,
            row: s.row_label,
            number: s.seat_number,
            section: s.section,
            category: s.category,
            tier_name: s.tier_name,
            price: s.price,
          })),
          created_at: new Date().toISOString(),
        };
      }, TX_OPTIONS);

      return res.status(201).json({ success: true, data: result });
    }

    // ── Tier-based booking (general admission — concerts, festivals, etc.) ────
    if (!tier_id || !quantity) {
      return res.status(400).json({ success: false, message: 'tier_id and quantity are required for general admission events' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const tier = await tx.event_ticket_tiers.findUnique({ where: { id: tier_id } });

      if (!tier || tier.event_id !== event_id) {
        const err = new Error('Tier not found'); err.status = 404; throw err;
      }
      if (tier.available_seats < quantity) {
        const err = new Error('Not enough event_seats available'); err.status = 409; throw err;
      }

      await tx.event_ticket_tiers.update({
        where: { id: tier_id },
        data: { available_seats: { decrement: quantity } },
      });

      const event = await tx.events.findUnique({
        where: { id: event_id },
        select: { title: true, venue_name: true, start_at: true },
      });

      const bookingId = generateBookingId();
      const ticketId = generateTicketId();
      const ticketCode = generateTicketCode();
      const totalAmount = tier.price * quantity;

      // Process wallet payment
      const journalCode = walletService.generateJournalCode();
      if (payment_method === 'WALLET') {
        await walletService.debitWallet(
          tx, userId, totalAmount, journalCode,
          `Event booking: ${event.title} — ${quantity} ticket(s)`
        );
      }

      await tx.event_bookings.create({
        data: {
          id: bookingId,
          ticket_code: ticketCode,
          user_id: userId,
          event_id,
          tier_id,
          quantity,
          total_amount: totalAmount,
          payment_method,
          attendee_names: JSON.stringify(attendee_names || []),
          status: 'confirmed',
          payment_status: payment_method === 'WALLET' ? 'paid' : 'pending',
          wallet_journal_code: payment_method === 'WALLET' ? journalCode : null,
        },
      });

      return {
        booking_id: bookingId,
        ticket_id: ticketId,
        ticket_code: ticketCode,
        event_id,
        event_title: event.title,
        tier_id,
        tier_name: tier.name,
        quantity,
        total_amount: totalAmount,
        payment_method,
        attendee_names: attendee_names || [],
        event_start_at: event.start_at,
        venue_name: event.venue_name,
        created_at: new Date().toISOString(),
      };
    }, TX_OPTIONS);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function myTickets(req, res, next) {
  try {
    const userId = BigInt(req.user.id);

    const event_bookings = await prisma.event_bookings.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: {
        events: { select: { title: true, venue_name: true, start_at: true } },
        event_ticket_tiers: { select: { name: true } },
        event_booking_seats: {
          include: {
            event_seats: { select: { row_label: true, seat_number: true, section: true, category: true } },
          },
        },
      },
    });

    const data = event_bookings.map((b) => ({
      id: b.id,
      ticket_code: b.ticket_code,
      event_id: b.event_id,
      event_title: b.events.title,
      tier_id: b.tier_id,
      tier_name: b.event_ticket_tiers.name,
      quantity: b.quantity,
      total_amount: b.total_amount,
      payment_method: b.payment_method,
      attendee_names: typeof b.attendee_names === 'string' ? JSON.parse(b.attendee_names) : b.attendee_names,
      event_start_at: b.events.start_at,
      venue_name: b.events.venue_name,
      created_at: b.created_at,
      status: b.status,
      event_seats: b.event_booking_seats.map((bs) => ({
        seat_id: bs.seat_id,
        row: bs.event_seats.row_label,
        number: bs.event_seats.seat_number,
        section: bs.event_seats.section,
        category: bs.event_seats.category,
      })),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function deleteBooking(req, res, next) {
  try {
    const { bookingId } = req.params;
    const userId = BigInt(req.user.id);

    const booking = await prisma.event_bookings.findUnique({ where: { id: bookingId } });

    if (!booking || booking.user_id !== userId) {
      const err = new Error('Booking not found'); err.status = 404; throw err;
    }

    await prisma.event_bookings.delete({ where: { id: bookingId } });

    res.json({ success: true, message: 'Booking deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { createBooking, myTickets, deleteBooking };
