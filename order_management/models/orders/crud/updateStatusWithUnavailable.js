// models/orders/crud/updateStatusWithUnavailable.js
const db = require("../../../config/db");

// ---- ETA formatting (same output pattern as your controller function) ----
function formatEtaRangeBhutan(estimated_minutes) {
  const mins = Number(estimated_minutes);
  if (!Number.isFinite(mins) || mins <= 0) return null;

  const now = new Date();
  const startDate = new Date(now.getTime() + mins * 60 * 1000);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

  const BHUTAN_OFFSET_HOURS = 6;

  const toBhutanParts = (d) => {
    const hour24 = (d.getUTCHours() + BHUTAN_OFFSET_HOURS) % 24;
    const minute = d.getUTCMinutes();
    const meridiem = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return { hour12, minute, meridiem };
  };

  const s = toBhutanParts(startDate);
  const e = toBhutanParts(endDate);

  const sStr = `${s.hour12}:${String(s.minute).padStart(2, "0")}`;
  const eStr = `${e.hour12}:${String(e.minute).padStart(2, "0")}`;

  return s.meridiem === e.meridiem
    ? `${sStr} - ${eStr} ${s.meridiem}`
    : `${sStr} ${s.meridiem} - ${eStr} ${e.meridiem}`;
}

// ---- helpers ----
const n2 = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
};

function normChanges(changes) {
  const uc = changes && typeof changes === "object" ? changes : {};

  const removed = Array.isArray(uc.removed) ? uc.removed : [];
  const replaced = Array.isArray(uc.replaced) ? uc.replaced : [];

  const removed_norm = removed
    .map((x) => ({
      business_id: Number(x?.business_id),
      menu_id: Number(x?.menu_id),
      item_name: x?.item_name ? String(x.item_name) : null,
    }))
    .filter(
      (x) =>
        Number.isFinite(x.business_id) &&
        x.business_id > 0 &&
        Number.isFinite(x.menu_id) &&
        x.menu_id > 0,
    );

  const replaced_norm = replaced
    .map((r) => {
      const oldB = Number(r?.old?.business_id);
      const oldM = Number(r?.old?.menu_id);
      if (
        !Number.isFinite(oldB) ||
        oldB <= 0 ||
        !Number.isFinite(oldM) ||
        oldM <= 0
      )
        return null;

      const n = r?.new || {};
      const newB = Number(n?.business_id);
      const newM = Number(n?.menu_id);
      if (
        !Number.isFinite(newB) ||
        newB <= 0 ||
        !Number.isFinite(newM) ||
        newM <= 0
      )
        return null;

      const quantity = Number(n?.quantity);
      const price = Number(n?.price);
      const subtotal = Number(n?.subtotal);

      return {
        old: {
          business_id: oldB,
          menu_id: oldM,
          item_name: r?.old?.item_name ? String(r.old.item_name) : null,
        },
        new: {
          business_id: newB,
          business_name: n?.business_name ? String(n.business_name) : null,
          menu_id: newM,
          item_name: n?.item_name ? String(n.item_name) : null,
          item_image: n?.item_image ? String(n.item_image) : null,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          price: Number.isFinite(price) && price >= 0 ? price : 0,
          subtotal:
            Number.isFinite(subtotal) && subtotal >= 0
              ? subtotal
              : (Number.isFinite(quantity) && quantity > 0 ? quantity : 1) *
                (Number.isFinite(price) && price >= 0 ? price : 0),
        },
      };
    })
    .filter(Boolean);

  return { removed_norm, replaced_norm };
}

/**
 * Update CONFIRMED + apply unavailable changes (remove/replace) in order_items
 *
 * Expects payload like:
 * {
 *   status:"CONFIRMED",
 *   reason,
 *   estimated_minutes,
 *   final_total_amount,
 *   final_platform_fee,
 *   final_discount_amount,
 *   final_delivery_fee,
 *   final_merchant_delivery_fee,
 *   unavailable_changes:{ removed:[...], replaced:[...] }
 * }
 */
module.exports = async function updateStatusWithUnavailable(
  order_id,
  payload = {},
) {
  const oid = String(order_id || "")
    .trim()
    .toUpperCase();
  if (!oid) return { ok: false, code: "BAD_ORDER_ID" };

  const status = String(payload.status || "")
    .trim()
    .toUpperCase();
  if (status !== "CONFIRMED")
    return { ok: false, code: "ONLY_CONFIRMED_SUPPORTED" };

  const reason = String(payload.reason || "").trim();

  const final_total_amount = n2(payload.final_total_amount);
  const final_platform_fee = n2(payload.final_platform_fee);
  const final_discount_amount = n2(payload.final_discount_amount);
  const final_delivery_fee = n2(payload.final_delivery_fee);
  const final_merchant_delivery_fee = n2(payload.final_merchant_delivery_fee);

  const etaStr =
    payload.estimated_minutes != null
      ? formatEtaRangeBhutan(payload.estimated_minutes)
      : null;

  const { removed_norm, replaced_norm } = normChanges(
    payload.unavailable_changes,
  );

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Ensure order exists (and lock it)
    const [[orderRow]] = await conn.query(
      `SELECT order_id, status
         FROM orders
        WHERE order_id = ?
        FOR UPDATE`,
      [oid],
    );
    if (!orderRow) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    // 1) REMOVE from order_items
    //    (delete by order_id + business_id + menu_id)
    for (const rm of removed_norm) {
      await conn.query(
        `DELETE FROM order_items
          WHERE order_id = ?
            AND business_id = ?
            AND menu_id = ?`,
        [oid, rm.business_id, rm.menu_id],
      );
    }

    // 2) REPLACE in order_items
    //    Update the existing row that matches old business_id/menu_id
    //    into the new item fields.
    for (const rep of replaced_norm) {
      const n = rep.new;

      const [upd] = await conn.query(
        `UPDATE order_items
            SET
              business_id   = ?,
              business_name = ?,
              menu_id       = ?,
              item_name     = ?,
              item_image    = ?,
              quantity      = ?,
              price         = ?,
              subtotal      = ?
          WHERE order_id = ?
            AND business_id = ?
            AND menu_id = ?
          LIMIT 1`,
        [
          n.business_id,
          n.business_name,
          n.menu_id,
          n.item_name,
          n.item_image,
          n.quantity,
          n.price,
          n.subtotal,
          oid,
          rep.old.business_id,
          rep.old.menu_id,
        ],
      );

      // If no row updated (old item not found), you can choose:
      // - insert a new row instead
      // - or fail
      // Here: we insert a new row as a safe fallback.
      if (!upd?.affectedRows) {
        await conn.query(
          `INSERT INTO order_items
            (order_id, business_id, business_name, menu_id, item_name, item_image, quantity, price, subtotal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            oid,
            n.business_id,
            n.business_name,
            n.menu_id,
            n.item_name,
            n.item_image,
            n.quantity,
            n.price,
            n.subtotal,
          ],
        );
      }
    }

    // 3) Recalculate items total from DB (after modifications)
    const [[sumRow]] = await conn.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS items_total
         FROM order_items
        WHERE order_id = ?`,
      [oid],
    );
    const items_total = Number(sumRow?.items_total || 0);

    // Optional sanity: you can recompute expected total and compare with final_total_amount
    // expected = items_total + delivery_fee - discount + platform_fee
    const expected_total =
      items_total +
      Number(final_delivery_fee || 0) -
      Number(final_discount_amount || 0) +
      Number(final_platform_fee || 0);

    // 4) Update orders (all latest fields)
    // NOTE: If your schema uses different column names, adjust here.
    // - estimated_arrivial_time is from your existing code.
    // - status_reason may or may not exist; if it doesn't, remove it from query.
    await conn.query(
      `
      UPDATE orders
         SET
           status = 'CONFIRMED',
           status_reason = ?,
           total_amount = ?,
           platform_fee = ?,
           discount_amount = ?,
           delivery_fee = ?,
           merchant_delivery_fee = ?,
           estimated_arrivial_time = COALESCE(?, estimated_arrivial_time),
           updated_at = NOW()
       WHERE order_id = ?
      `,
      [
        reason || null,
        final_total_amount != null ? final_total_amount : n2(expected_total),
        final_platform_fee != null ? final_platform_fee : 0,
        final_discount_amount != null ? final_discount_amount : 0,
        final_delivery_fee != null ? final_delivery_fee : 0,
        final_merchant_delivery_fee != null ? final_merchant_delivery_fee : 0,
        etaStr,
        oid,
      ],
    );

    await conn.commit();

    return {
      ok: true,
      order_id: oid,
      status: "CONFIRMED",
      estimated_arrivial_time: etaStr,
      items_total: n2(items_total),
      expected_total: n2(expected_total),
      applied: {
        removed_count: removed_norm.length,
        replaced_count: replaced_norm.length,
      },
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    return { ok: false, code: "DB_ERROR", error: e?.message || String(e) };
  } finally {
    conn.release();
  }
};
