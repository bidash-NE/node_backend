const prisma = require('../../db');

async function getSummary(req, res, next) {
  try {
    const { from_date, to_date } = req.query;

    const dateFilter = {};
    if (from_date) dateFilter.gte = new Date(from_date);
    if (to_date) dateFilter.lte = new Date(to_date);
    const where = { status: 'confirmed', ...(Object.keys(dateFilter).length && { created_at: dateFilter }) };

    const [totals, byPaymentMethod, bookingsRaw] = await Promise.all([
      prisma.event_bookings.aggregate({
        where,
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ['payment_method'],
        where,
        _sum: { total_amount: true },
        _count: { id: true },
      }),
      prisma.event_bookings.findMany({
        where,
        select: { event_id: true, total_amount: true },
      }),
    ]);

    // Category breakdown via in-memory join
    const eventIds = [...new Set(bookingsRaw.map((b) => b.event_id))];
    const events = await prisma.events.findMany({
      where: { id: { in: eventIds } },
      select: { id: true, category: true },
    });
    const categoryMap = new Map(events.map((e) => [e.id, e.category]));
    const byCategoryMap = {};
    for (const b of bookingsRaw) {
      const cat = categoryMap.get(b.event_id) || 'unknown';
      if (!byCategoryMap[cat]) byCategoryMap[cat] = { revenue: 0, booking_count: 0 };
      byCategoryMap[cat].revenue += b.total_amount;
      byCategoryMap[cat].booking_count += 1;
    }

    // Daily trend via parameterized raw query
    const fromTs = from_date ? new Date(from_date) : new Date('2020-01-01');
    const toTs = to_date ? new Date(to_date) : new Date('2099-12-31');
    const dailyTrend = await prisma.$queryRaw`
      SELECT DATE(created_at) AS date,
             SUM(total_amount) AS revenue,
             COUNT(id) AS bookings
      FROM event_bookings
      WHERE status = 'confirmed'
        AND created_at >= ${fromTs}
        AND created_at <= ${toTs}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;

    res.json({
      success: true,
      data: {
        gross_revenue: totals._sum.total_amount || 0,
        tickets_sold: totals._sum.quantity || 0,
        total_bookings: totals._count.id,
        avg_ticket_value: totals._count.id > 0
          ? Math.round((totals._sum.total_amount || 0) / totals._count.id)
          : 0,
        by_payment_method: byPaymentMethod.map((r) => ({
          method: r.payment_method,
          revenue: r._sum.total_amount || 0,
          count: r._count.id,
        })),
        by_category: Object.entries(byCategoryMap).map(([category, stats]) => ({ category, ...stats })),
        daily_trend: dailyTrend,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getEventRevenue(req, res, next) {
  try {
    const { id } = req.params;

    const event = await prisma.events.findUnique({
      where: { id },
      select: { id: true, title: true, category: true, venue_name: true, start_at: true },
    });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    const bookingWhere = { event_id: id, status: 'confirmed' };

    const [totals, byTier, byPaymentMethod, screenings] = await Promise.all([
      prisma.event_bookings.aggregate({
        where: bookingWhere,
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ['tier_id'],
        where: bookingWhere,
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ['payment_method'],
        where: bookingWhere,
        _sum: { total_amount: true },
        _count: { id: true },
      }),
      prisma.event_screenings.findMany({
        where: { event_id: id },
        include: { event_halls: { select: { name: true, total_seats: true } } },
      }),
    ]);

    // Enrich tier names
    const tierIds = byTier.map((t) => t.tier_id);
    const tiers = await prisma.event_ticket_tiers.findMany({
      where: { id: { in: tierIds } },
      select: { id: true, name: true },
    });
    const tierNameMap = new Map(tiers.map((t) => [t.id, t.name]));

    // Screening occupancy
    const screeningIds = screenings.map((s) => s.id);
    const bookedCounts = await prisma.event_booking_seats.groupBy({
      by: ['screening_id'],
      where: {
        screening_id: { in: screeningIds },
        event_bookings: { status: 'confirmed' },
      },
      _count: { seat_id: true },
    });
    const bookedMap = new Map(bookedCounts.map((b) => [b.screening_id, b._count.seat_id]));

    const screeningOccupancy = screenings.map((s) => {
      const booked = bookedMap.get(s.id) || 0;
      const total = s.event_halls.total_seats;
      return {
        id: s.id,
        show_date: s.show_date.toISOString().slice(0, 10),
        show_time: s.show_time.toISOString().slice(11, 16),
        hall_name: s.event_halls.name,
        total_seats: total,
        booked_seats: booked,
        occupancy_pct: total > 0 ? Math.round((booked / total) * 1000) / 10 : 0,
        status: s.status,
      };
    });

    res.json({
      success: true,
      data: {
        event,
        gross_revenue: totals._sum.total_amount || 0,
        tickets_sold: totals._sum.quantity || 0,
        total_bookings: totals._count.id,
        avg_ticket_value: totals._count.id > 0
          ? Math.round((totals._sum.total_amount || 0) / totals._count.id)
          : 0,
        by_tier: byTier.map((t) => ({
          tier_id: t.tier_id,
          tier_name: tierNameMap.get(t.tier_id) || 'Unknown',
          revenue: t._sum.total_amount || 0,
          tickets_sold: t._sum.quantity || 0,
          booking_count: t._count.id,
        })),
        by_payment_method: byPaymentMethod.map((r) => ({
          method: r.payment_method,
          revenue: r._sum.total_amount || 0,
          count: r._count.id,
        })),
        screening_occupancy: screeningOccupancy,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getPaymentSessions(req, res, next) {
  try {
    const { status, from_date, to_date, page = 1, limit = 20 } = req.query;

    const dateFilter = {};
    if (from_date) dateFilter.gte = new Date(from_date);
    if (to_date) dateFilter.lte = new Date(to_date);

    const where = {
      ...(status && { status }),
      ...(Object.keys(dateFilter).length && { created_at: dateFilter }),
    };

    const [sessions, total] = await prisma.$transaction([
      prisma.event_payment_sessions.findMany({
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: { created_at: 'desc' },
        include: { users: { select: { user_name: true, email: true } } },
      }),
      prisma.event_payment_sessions.count({ where }),
    ]);

    const data = sessions.map((s) => ({
      id: s.id,
      order_no: s.order_no,
      bfs_txn_id: s.bfs_txn_id,
      amount: s.amount,
      status: s.status,
      user_name: s.users.user_name,
      user_email: s.users.email,
      payment_context: s.payment_context,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));

    res.json({ success: true, data, total, page: Number(page) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary, getEventRevenue, getPaymentSessions };
