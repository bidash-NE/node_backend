// models/cancelledOrderModels.js
const db = require("../config/db");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uniqStrings(arr) {
  return Array.from(
    new Set(
      (arr || [])
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

async function withRetry(fn, { retries = 2, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = e?.code;
      if (code === "ER_LOCK_WAIT_TIMEOUT" || code === "ER_LOCK_DEADLOCK") {
        // small backoff + retry
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// models/cancelledOrderModels.js
async function getCancelledOrdersByUser(
  user_id,
  { limit = 50, offset = 0 } = {}
) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);

  const [orders] = await db.query(
    `
    SELECT
      co.cancelled_id,
      co.order_id,
      co.user_id,
      co.status,
      co.status_reason,
      co.total_amount,
      co.discount_amount,
      co.delivery_fee,
      co.platform_fee,
      co.merchant_delivery_fee,
      co.payment_method,
      co.delivery_address,
      co.note_for_restaurant,
      co.if_unavailable,
      co.fulfillment_type,
      co.priority,
      co.estimated_arrivial_time,
      co.cancelled_by,
      co.cancelled_at,
      co.original_created_at,
      co.original_updated_at
    FROM cancelled_orders co
    WHERE co.user_id = ?
    ORDER BY co.cancelled_at DESC
    LIMIT ? OFFSET ?
    `,
    [user_id, lim, off]
  );

  const [[cnt]] = await db.query(
    `SELECT COUNT(*) AS total FROM cancelled_orders WHERE user_id = ?`,
    [user_id]
  );
  const total = Number(cnt?.total || 0);

  if (!orders.length) {
    return { rows: [], total, limit: lim, offset: off };
  }

  const orderIds = orders.map((o) => o.order_id);

  const [items] = await db.query(
    `
    SELECT
      order_id,
      business_id,
      business_name,
      menu_id,
      item_name,
      item_image,
      quantity,
      price,
      subtotal,
      created_at
    FROM cancelled_order_items
    WHERE order_id IN (?)
    ORDER BY order_id, cancelled_item_id ASC
    `,
    [orderIds]
  );

  // Group items by order
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }

  // Collect all business_ids from items (because cancelled_orders has no service_type column)
  const businessIds = Array.from(
    new Set(
      items
        .map((it) => Number(it.business_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  );

  // Map business_id -> service_type derived from owner_type (MART/FOOD)
  const serviceTypeByBusiness = new Map();

  if (businessIds.length) {
    // ✅ Adjust table/column name if your schema differs:
    // - Table assumed: merchant_business_details
    // - Columns assumed: business_id, owner_type (values like 'mart' / 'food')
    const [bizRows] = await db.query(
      `
      SELECT business_id, owner_type
      FROM merchant_business_details
      WHERE business_id IN (?)
      `,
      [businessIds]
    );

    for (const r of bizRows) {
      const bid = Number(r.business_id);
      const owner = String(r.owner_type || "")
        .trim()
        .toUpperCase();
      if (!Number.isFinite(bid) || bid <= 0) continue;

      // Normalize owner_type into exactly "MART" or "FOOD" when possible
      let st = owner;
      if (owner === "MART" || owner === "FOOD") {
        st = owner;
      } else if (owner.includes("MART")) {
        st = "MART";
      } else if (owner.includes("FOOD") || owner.includes("RESTAUR")) {
        st = "FOOD";
      } else {
        // fallback: keep owner_type uppercased if it's something else
        st = owner || null;
      }

      serviceTypeByBusiness.set(bid, st);
    }
  }

  // Build output rows: add service_type per order derived from item's business_id -> owner_type
  const rows = orders.map((o) => {
    const orderItems = itemsByOrder.get(o.order_id) || [];

    // Pick first business_id for service_type (most orders are single-business)
    const firstBizId = orderItems.length
      ? Number(orderItems[0].business_id)
      : null;

    let service_type =
      Number.isFinite(firstBizId) && serviceTypeByBusiness.has(firstBizId)
        ? serviceTypeByBusiness.get(firstBizId)
        : null;

    // If first item didn’t resolve, try any other item business_id
    if (!service_type && orderItems.length) {
      for (const it of orderItems) {
        const bid = Number(it.business_id);
        if (Number.isFinite(bid) && serviceTypeByBusiness.has(bid)) {
          service_type = serviceTypeByBusiness.get(bid);
          break;
        }
      }
    }

    return {
      ...o,
      service_type: service_type || null, // e.g., "MART" / "FOOD"
      items: orderItems,
    };
  });

  return { rows, total, limit: lim, offset: off };
}

/**
 * Delete one cancelled order for a user (also deletes its cancelled items).
 * Uses a transaction + row lock to avoid race conditions.
 */
async function deleteCancelledOrderByUser(user_id, order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // fail fast instead of waiting 50s
    await conn.query(`SET SESSION innodb_lock_wait_timeout = 3`);

    // delete items first (works even if FK/cascade is missing)
    await conn.query(`DELETE FROM cancelled_order_items WHERE order_id = ?`, [
      order_id,
    ]);

    const [r] = await conn.query(
      `DELETE FROM cancelled_orders WHERE user_id = ? AND order_id = ?`,
      [user_id, order_id]
    );

    await conn.commit();
    return { deleted: r.affectedRows > 0 };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Delete many cancelled orders for a user (also deletes items).
 * Locks only the matching order_ids.
 */
async function deleteManyCancelledOrdersByUser(user_id, order_ids = []) {
  const ids = uniqStrings(order_ids);
  if (!ids.length) return { ok: false, code: "EMPTY_LIST" };

  // optional: chunk to avoid very large IN()
  const CHUNK = 200;
  let totalDeleted = 0;

  return withRetry(async () => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);

        // Lock only rows that exist for this user
        const [rows] = await conn.query(
          `SELECT order_id FROM cancelled_orders WHERE user_id = ? AND order_id IN (?) FOR UPDATE`,
          [user_id, chunk]
        );
        const found = rows.map((r) => r.order_id);
        if (!found.length) continue;

        await conn.query(
          `DELETE FROM cancelled_order_items WHERE order_id IN (?)`,
          [found]
        );
        const [del] = await conn.query(
          `DELETE FROM cancelled_orders WHERE user_id = ? AND order_id IN (?)`,
          [user_id, found]
        );
        totalDeleted += Number(del.affectedRows || 0);
      }

      await conn.commit();
      return { ok: true, deleted: totalDeleted };
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      throw e;
    } finally {
      conn.release();
    }
  });
}

module.exports = {
  getCancelledOrdersByUser,
  deleteCancelledOrderByUser,
  deleteManyCancelledOrdersByUser,
};
