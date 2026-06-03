// models/orders/crud/updateStatusWithUnavailable.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Preserves same logic:
//    - only supports CONFIRMED
//    - applies unavailable removals/replacements
//    - recalculates items_total from order_items
//    - updates order status/totals/ETA in one transaction

const { prisma } = require("../helpers");

// ---- ETA formatting, same output pattern as your controller function ----
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

    return {
      hour12,
      minute,
      meridiem,
    };
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

function normalizeOrderId(order_id) {
  return String(order_id || "").trim().toUpperCase();
}

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNumberOrDefault(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normChanges(changes) {
  const uc = changes && typeof changes === "object" ? changes : {};

  const removed = Array.isArray(uc.removed) ? uc.removed : [];
  const replaced = Array.isArray(uc.replaced) ? uc.replaced : [];

  const removed_norm = removed
    .map((x) => ({
      business_id: toIntOrNull(x?.business_id),
      menu_id: toIntOrNull(x?.menu_id),
      item_name: x?.item_name ? String(x.item_name) : null,
    }))
    .filter((x) => x.business_id && x.menu_id);

  const replaced_norm = replaced
    .map((r) => {
      const oldB = toIntOrNull(r?.old?.business_id);
      const oldM = toIntOrNull(r?.old?.menu_id);

      if (!oldB || !oldM) return null;

      const n = r?.new || {};

      const newB = toIntOrNull(n?.business_id);
      const newM = toIntOrNull(n?.menu_id);

      if (!newB || !newM) return null;

      const quantityRaw = Number(n?.quantity);
      const priceRaw = Number(n?.price);
      const subtotalRaw = Number(n?.subtotal);

      const quantity =
        Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;

      const price =
        Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0;

      const subtotal =
        Number.isFinite(subtotalRaw) && subtotalRaw >= 0
          ? subtotalRaw
          : quantity * price;

      return {
        old: {
          business_id: oldB,
          menu_id: oldM,
          item_name: r?.old?.item_name ? String(r.old.item_name) : null,
        },
        new: {
          business_id: newB,
          business_name: toStrOrNull(n?.business_name),
          menu_id: newM,
          item_name: toStrOrNull(n?.item_name),
          item_image: toStrOrNull(n?.item_image),
          quantity,
          price,
          subtotal,
        },
      };
    })
    .filter(Boolean);

  return {
    removed_norm,
    replaced_norm,
  };
}

/**
 * Delete exactly one matching order_item.
 *
 * Old SQL for replace used:
 * UPDATE ... WHERE order_id=? AND business_id=? AND menu_id=? LIMIT 1
 *
 * Prisma does not support LIMIT 1 on updateMany/deleteMany.
 * So we first find one row by item_id, then update/delete by item_id.
 */
async function findOneOrderItemId(tx, { order_id, business_id, menu_id }) {
  const row = await tx.order_items.findFirst({
    where: {
      order_id,
      business_id,
      menu_id,
    },
    select: {
      item_id: true,
    },
    orderBy: {
      item_id: "asc",
    },
  });

  return row?.item_id || null;
}

/**
 * Update CONFIRMED + apply unavailable changes.
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
  const oid = normalizeOrderId(order_id);

  if (!oid) {
    return {
      ok: false,
      code: "BAD_ORDER_ID",
    };
  }

  const status = String(payload.status || "").trim().toUpperCase();

  if (status !== "CONFIRMED") {
    return {
      ok: false,
      code: "ONLY_CONFIRMED_SUPPORTED",
    };
  }

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

  try {
    return await prisma.$transaction(async (tx) => {
      // Ensure order exists.
      // Note: Prisma does not expose SELECT ... FOR UPDATE directly without raw SQL.
      // The transaction still ensures all following modifications commit/rollback together.
      const orderRow = await tx.orders.findUnique({
        where: {
          order_id: oid,
        },
        select: {
          order_id: true,
          status: true,
        },
      });

      if (!orderRow) {
        return {
          ok: false,
          code: "NOT_FOUND",
        };
      }

      // 1) REMOVE from order_items
      // Old raw SQL removed all matching rows because it had no LIMIT here.
      for (const rm of removed_norm) {
        await tx.order_items.deleteMany({
          where: {
            order_id: oid,
            business_id: rm.business_id,
            menu_id: rm.menu_id,
          },
        });
      }

      // 2) REPLACE in order_items
      // Old logic:
      // - update one matching old row into new fields
      // - if no row updated, insert new row
      for (const rep of replaced_norm) {
        const n = rep.new;

        const itemId = await findOneOrderItemId(tx, {
          order_id: oid,
          business_id: rep.old.business_id,
          menu_id: rep.old.menu_id,
        });

        if (itemId) {
          await tx.order_items.update({
            where: {
              item_id: itemId,
            },
            data: {
              business_id: n.business_id,
              business_name: n.business_name,
              menu_id: n.menu_id,
              item_name: n.item_name,
              item_image: n.item_image,
              quantity: n.quantity,
              price: n.price,
              subtotal: n.subtotal,
            },
          });
        } else {
          await tx.order_items.create({
            data: {
              order_id: oid,
              business_id: n.business_id,
              business_name: n.business_name,
              menu_id: n.menu_id,
              item_name: n.item_name,
              item_image: n.item_image,
              quantity: n.quantity,
              price: n.price,
              subtotal: n.subtotal,
              platform_fee: 0,
              delivery_fee: 0,
            },
          });
        }
      }

      // 3) Recalculate items total from DB after modifications
      const sum = await tx.order_items.aggregate({
        where: {
          order_id: oid,
        },
        _sum: {
          subtotal: true,
        },
      });

      const items_total = Number(sum._sum.subtotal || 0);

      const expected_total =
        items_total +
        Number(final_delivery_fee || 0) -
        Number(final_discount_amount || 0) +
        Number(final_platform_fee || 0);

      // 4) Update order
      const updateData = {
        status: "CONFIRMED",
        status_reason: reason || null,
        total_amount:
          final_total_amount != null ? final_total_amount : n2(expected_total),
        platform_fee: final_platform_fee != null ? final_platform_fee : 0,
        discount_amount:
          final_discount_amount != null ? final_discount_amount : 0,
        delivery_fee: final_delivery_fee != null ? final_delivery_fee : 0,
        merchant_delivery_fee:
          final_merchant_delivery_fee != null
            ? final_merchant_delivery_fee
            : 0,
        updated_at: new Date(),
      };

      if (etaStr) {
        updateData.estimated_arrivial_time = etaStr;
      }

      await tx.orders.update({
        where: {
          order_id: oid,
        },
        data: updateData,
      });

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
    });
  } catch (e) {
    return {
      ok: false,
      code: "DB_ERROR",
      error: e?.message || String(e),
    };
  }
};