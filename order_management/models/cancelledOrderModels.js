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

  if (!orders.length) {
    const [[cnt]] = await db.query(
      `SELECT COUNT(*) AS total FROM cancelled_orders WHERE user_id = ?`,
      [user_id]
    );
    return {
      rows: [],
      total: Number(cnt?.total || 0),
      limit: lim,
      offset: off,
    };
  }

  const ids = orders.map((o) => o.order_id);
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
    [ids]
  );

  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }

  const out = orders.map((o) => ({
    ...o,
    items: itemsByOrder.get(o.order_id) || [],
  }));

  const [[cnt]] = await db.query(
    `SELECT COUNT(*) AS total FROM cancelled_orders WHERE user_id = ?`,
    [user_id]
  );

  return { rows: out, total: Number(cnt?.total || 0), limit: lim, offset: off };
}

/**
 * Delete one cancelled order for a user (also deletes its cancelled items).
 * Uses a transaction + row lock to avoid race conditions.
 */
async function deleteCancelledOrderByUser(user_id, order_id) {
  return withRetry(async () => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Lock the single row by unique key (order_id) first
      const [[row]] = await conn.query(
        `SELECT order_id FROM cancelled_orders WHERE order_id = ? AND user_id = ? FOR UPDATE`,
        [order_id, user_id]
      );
      if (!row) {
        await conn.rollback();
        return { ok: false, code: "NOT_FOUND" };
      }

      // Explicitly delete items first (even if FK cascade exists)
      await conn.query(`DELETE FROM cancelled_order_items WHERE order_id = ?`, [
        order_id,
      ]);
      await conn.query(
        `DELETE FROM cancelled_orders WHERE order_id = ? AND user_id = ?`,
        [order_id, user_id]
      );

      await conn.commit();
      return { ok: true, deleted: 1 };
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
