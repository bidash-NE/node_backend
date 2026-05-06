const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const prisma = require('../../db');

const DEFAULT_PASSWORD = 'password123';

async function listOrganizers(req, res, next) {
  try {
    const organizers = await prisma.event_organizers.findMany({
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { events: true } } },
    });

    res.json({
      success: true,
      data: organizers.map((o) => ({
        id: o.id,
        name: o.name,
        event_count: o._count.events,
        created_at: o.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function createOrganizer(req, res, next) {
  try {
    if (req.user.role === 'organizer') {
      return res.status(403).json({ success: false, message: 'Forbidden: organizers cannot add other organizers' });
    }

    const { name, email, phone } = req.body;
    if (!name || !email || !phone) {
      return res.status(400).json({ success: false, message: 'name, email, and phone are required' });
    }

    const existing = await prisma.users.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A user with this email already exists' });
    }

    const password_hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    // Create user first to get the auto-generated user_id, then link organizer to it
    const user = await prisma.users.create({
      data: { user_name: name, email, phone, password_hash, role: 'organizer', is_verified: true, is_active: true },
    });

    const organizer = await prisma.event_organizers.create({
      data: { id: uuidv4(), name, user_id: user.user_id },
    });

    res.status(201).json({
      success: true,
      data: { id: organizer.id, name: organizer.name, email, phone, default_password: DEFAULT_PASSWORD },
    });
  } catch (err) {
    next(err);
  }
}

async function getOrganizerRevenue(req, res, next) {
  try {
    const { id } = req.params;

    const organizer = await prisma.event_organizers.findUnique({ where: { id } });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });

    const events = await prisma.events.findMany({
      where: { organizer_id: id },
      select: { id: true, title: true, category: true, start_at: true },
    });

    const eventIds = events.map((e) => e.id);

    const [totals, byEvent] = await Promise.all([
      prisma.event_bookings.aggregate({
        where: { event_id: { in: eventIds }, status: 'confirmed' },
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds }, status: 'confirmed' },
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
    ]);

    const revenueMap = new Map(byEvent.map((b) => [b.event_id, b]));

    res.json({
      success: true,
      data: {
        organizer: { id: organizer.id, name: organizer.name },
        gross_revenue: totals._sum.total_amount || 0,
        tickets_sold: totals._sum.quantity || 0,
        total_bookings: totals._count.id,
        events: events.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category,
          start_at: e.start_at,
          revenue: revenueMap.get(e.id)?._sum.total_amount || 0,
          tickets_sold: revenueMap.get(e.id)?._sum.quantity || 0,
          booking_count: revenueMap.get(e.id)?._count.id || 0,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function deleteOrganizer(req, res, next) {
  try {
    if (req.user.role === 'organizer') {
      return res.status(403).json({ success: false, message: 'Forbidden: organizers cannot remove organizers' });
    }

    const { id } = req.params;

    const organizer = await prisma.event_organizers.findUnique({
      where: { id },
      include: { _count: { select: { events: true } } },
    });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });

    if (organizer._count.events > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot remove organizer — they have ${organizer._count.events} event(s). Delete or reassign those events first.`,
      });
    }

    const userId = organizer.user_id;
    await prisma.event_organizers.delete({ where: { id } });
    if (userId) await prisma.users.delete({ where: { user_id: userId } });

    res.json({ success: true, message: `Organizer "${organizer.name}" removed.` });
  } catch (err) {
    next(err);
  }
}

module.exports = { listOrganizers, createOrganizer, deleteOrganizer, getOrganizerRevenue };
