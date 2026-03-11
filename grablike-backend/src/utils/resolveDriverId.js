// src/utils/resolveDriverId.js (ESM)
export async function resolveDriverIdFromUserId({ userId, baseUrl }) {
  if (!userId) throw new Error("userId is required to resolve driver_id");

  const url = `${String(baseUrl || "").replace(
    /\/+$/,
    "",
  )}/api/drivers/by-user/${encodeURIComponent(String(userId))}`;

  const res = await fetch(url, { method: "GET" });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json?.error || json?.message || "Driver lookup failed");
  }

  // Accept a few common response shapes safely:
  const driverId =
    json?.driver_id ??
    json?.data?.driver_id ??
    json?.data?.driver?.driver_id ??
    json?.driver?.driver_id ??
    null;

  if (!driverId) throw new Error("driver_id not found for this user");

  return String(driverId);
}

export async function resolveUserIdFromDriverId({ mysqlPool, driverId }) {
  if (!driverId) throw new Error("driverId is required to resolve user_id");
  try {
    console.log("Driver Id: ", driverId);

    if (!Number.isFinite(driverId) || driverId <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Valid driverId is required" });
    }

    const conn = await mysqlPool.getConnection();
    try {
      const [[row]] = await conn.query(
        "SELECT user_id FROM drivers WHERE driver_id = ? LIMIT 1",
        [driverId],
      );

      if (!row) {
        return res.status(404).json({
          ok: false,
          error: `No driver found for driver_id=${driverId}`,
        });
      }
      console.log("User Id: ", row.user_id);
      return String(row.user_id);
    } finally {
      try {
        conn.release();
      } catch {}
    }
  } catch (err) {
    console.error("[GET /api/driver_id] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

// get driver details (including user details) from batch_id
export async function resolveDriverDetailsFromOrderBatchedIds(db, { batchId }) {
  if (!batchId) throw new Error("batchId is required");

  let conn;
  let isConnectionProvided = typeof db.query === "function"; // simple check for connection

  try {
    if (isConnectionProvided) {
      conn = db; // use the provided connection directly
    } else {
      conn = await db.getConnection(); // assume it's a pool
    }

    const [[row]] = await conn.query(
      `SELECT o.delivery_driver_id, d.user_id FROM orders o
       JOIN drivers d ON d.driver_id = o.delivery_driver_id
       WHERE o.batch_id = ? LIMIT 1`,
      [batchId],
    );

    if (!row) return null;

    const [[userDetails]] = await conn.query(
      "SELECT * FROM users WHERE user_id = ? LIMIT 1",
      [row.user_id],
    );

    return {
      driver_id: String(row.delivery_driver_id),
      user_details: userDetails,
    };
  } finally {
    // Only release if we acquired the connection ourselves
    if (!isConnectionProvided && conn) {
      try {
        conn.release();
      } catch {}
    }
  }
}
