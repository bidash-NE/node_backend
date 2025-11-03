// src/services/cancellations.js
/**
 * Applies cancellation policy either for a whole ride OR a single booking (pool seat).
 * Expect an open SQL transaction via `conn`.
 *
 * Returns:
 * {
 *   applied: boolean,
 *   stage: 'accepted'|'arrived_pickup'|null,
 *   rule_id: number|null,
 *   fee_cents: number,
 *   driver_share_cents: number,
 *   platform_share_cents: number
 * }
 */
export async function applyCancellationPolicy({ conn, rideId, bookingId = null }) {
  // Determine stage from ride
  const [[ride]] = await conn.query(
    `SELECT status, fare_cents, currency FROM rides WHERE ride_id = ?`,
    [rideId]
  );
  if (!ride) return { applied: false, stage: null, rule_id: null, fee_cents: 0, driver_share_cents: 0, platform_share_cents: 0 };

  const stage =
    ride.status === "arrived_pickup" ? "arrived_pickup" :
    ride.status === "accepted" ? "accepted" : null;

  if (!stage) {
    // no late cancel fee outside accepted/arrived
    return { applied: false, stage, rule_id: null, fee_cents: 0, driver_share_cents: 0, platform_share_cents: 0 };
  }

  // Base amount: booking fare if bookingId given; otherwise ride fare
  let baseFareCents = Number(ride.fare_cents) || 0;
  if (bookingId) {
    const [[bk]] = await conn.query(
      `SELECT fare_cents, currency FROM ride_bookings WHERE booking_id = ? AND ride_id = ?`,
      [bookingId, rideId]
    );
    if (bk) baseFareCents = Number(bk.fare_cents) || 0;
  }

  // Pick best active rule for this stage
  const [[rule]] = await conn.query(
    `SELECT *
       FROM cancellation_rules
      WHERE is_active = 1
        AND stage_from = ?
        AND starts_at <= NOW()
        AND (ends_at IS NULL OR ends_at >= NOW())
      ORDER BY priority ASC, rule_id ASC
      LIMIT 1`,
    [stage]
  );

  if (!rule) {
    return { applied: false, stage, rule_id: null, fee_cents: 0, driver_share_cents: 0, platform_share_cents: 0 };
  }

  const fixedCents = Number(rule.passenger_fee_cents) || 0;
  const percentBp  = Number(rule.passenger_fee_percent_bp) || 0;

  let fee_cents = fixedCents;
  if (percentBp > 0) {
    fee_cents += Math.floor((baseFareCents * percentBp) / 10000);
  }
  if (fee_cents < 0) fee_cents = 0;

  const toDriverBp = Number(rule.payout_percent_to_driver_bp) || 0; // 10000 = 100%
  let driver_share_cents = Math.floor((fee_cents * toDriverBp) / 10000);
  if (driver_share_cents < 0) driver_share_cents = 0;
  const platform_share_cents = Math.max(0, fee_cents - driver_share_cents);

  // Optionally: persist this to a dedicated cancellation ledger table
  await conn.execute(
    `INSERT INTO cancellation_levies
       (ride_id, booking_id, fee_cents, driver_share_cents, platform_share_cents, stage, rule_id, created_at)
     VALUES (?,?,?,?,?,?,?, NOW())`,
    [rideId, bookingId, fee_cents, driver_share_cents, platform_share_cents, stage, rule?.rule_id || null]
  );

  return {
    applied: fee_cents > 0,
    stage,
    rule_id: rule?.rule_id || null,
    fee_cents,
    driver_share_cents,
    platform_share_cents,
  };
}
