// models/orders/orderArchivePipeline.js
// ✅ Prisma-transition version
// ✅ Fixes payment_method enum mismatch for cancelled_orders / delivered_orders
// ✅ Keeps db/conn only for wallet capture, points, and revenue engines that still need MySQL transaction connection

const db = require("../../config/db");
const { prisma } = require("../../lib/prisma");

const {
  ensureStatusReasonSupport,
  ensureDeliveryExtrasSupport,
} = require("./schemaSupport");

const { resolveOrderServiceType } = require("./serviceTypeResolver");

const { awardPointsForCompletedOrderWithConn } = require("./pointsEngine");

const {
  insertMerchantEarningWithConn,
  insertFoodMartRevenueWithConn,
  buildItemsSummary,
} = require("./revenueSnapshot");

const {
  captureOrderFundsWithConn,
  captureOrderCODFeeWithConn,
  prefetchTxnIdsBatch,
} = require("./walletCaptureEngine");

/* ================= PRISMA HELPERS ================= */

function prismaModelExists(modelName) {
  try {
    return !!prisma?._runtimeDataModel?.models?.[modelName];
  } catch {
    return false;
  }
}

function prismaModelFields(modelName) {
  try {
    const model = prisma?._runtimeDataModel?.models?.[modelName];

    if (!model || !Array.isArray(model.fields)) {
      return new Set();
    }

    return new Set(model.fields.map((f) => f.name));
  } catch {
    return new Set();
  }
}

function filterDataForModel(modelName, data) {
  const fields = prismaModelFields(modelName);
  const out = {};

  for (const [key, value] of Object.entries(data || {})) {
    if (fields.has(key)) {
      out[key] = value;
    }
  }

  return out;
}

function hasField(modelName, fieldName) {
  return prismaModelFields(modelName).has(fieldName);
}

function cleanOrderId(order_id) {
  return String(order_id || "").trim().toUpperCase();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function firstPhotoFromList(v) {
  if (v == null) return null;

  if (Array.isArray(v)) {
    return v.map(String).filter(Boolean)[0] || null;
  }

  const s = String(v).trim();
  if (!s) return null;

  try {
    const arr = JSON.parse(s);

    if (Array.isArray(arr)) {
      return arr.map(String).filter(Boolean)[0] || null;
    }

    return s;
  } catch {
    return s;
  }
}

/**
 * Important:
 * orders.payment_method enum uses values like: Wallet, COD, Card
 * cancelled_orders / delivered_orders payment_method enums expect uppercase: WALLET, COD, CARD
 */
function normalizeArchivePaymentMethod(v) {
  const s = String(v || "").trim().toUpperCase();

  if (s === "WALLET") return "WALLET";
  if (s === "COD") return "COD";
  if (s === "CARD") return "CARD";

  return "WALLET";
}

/* ================= ARCHIVE HELPERS ================= */

async function archiveCancelledOrderInternal(
  tx,
  order_id,
  { cancelled_by = "SYSTEM", reason = "" } = {},
) {
  const oid = cleanOrderId(order_id);

  const hasCancelledOrders = prismaModelExists("cancelled_orders");
  const hasCancelledItems = prismaModelExists("cancelled_order_items");

  if (!hasCancelledOrders && !hasCancelledItems) {
    return { archived: false };
  }

  const order = await tx.orders.findUnique({
    where: {
      order_id: oid,
    },
  });

  if (!order) {
    return { archived: false };
  }

  const items = await tx.order_items.findMany({
    where: {
      order_id: oid,
    },
  });

  let resolvedServiceType = null;

  try {
    resolvedServiceType = await resolveOrderServiceType(oid, tx);
  } catch {
    resolvedServiceType =
      (order.service_type ? String(order.service_type).toUpperCase() : null) ||
      "FOOD";
  }

  const finalReason =
    String(reason || "").trim() ||
    String(order.status_reason || "").trim() ||
    "";

  if (hasCancelledOrders) {
    const rawRow = {
      order_id: order.order_id,
      user_id: order.user_id,
      service_type: resolvedServiceType || null,

      payment_method: normalizeArchivePaymentMethod(order.payment_method),

      total_amount: order.total_amount,
      discount_amount: order.discount_amount,
      delivery_fee: order.delivery_fee,
      merchant_delivery_fee: order.merchant_delivery_fee,
      platform_fee: order.platform_fee,

      delivery_address: order.delivery_address,
      note_for_restaurant: order.note_for_restaurant,
      if_unavailable: order.if_unavailable,

      status: "CANCELLED",

      status_reason: finalReason,
      cancel_reason: finalReason,
      cancelled_reason: finalReason,
      reason: finalReason,

      cancelled_by,
      cancelled_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const row = filterDataForModel("cancelled_orders", rawRow);

    if (Object.keys(row).length) {
      await tx.cancelled_orders.createMany({
        data: [row],
        skipDuplicates: true,
      });
    }
  }

  if (hasCancelledItems && items.length) {
    const data = [];

    for (const it of items) {
      const rawRow = {
        order_id: it.order_id,
        business_id: it.business_id,
        business_name: it.business_name,
        menu_id: it.menu_id,
        item_name: it.item_name,
        item_image: it.item_image,
        quantity: it.quantity,
        price: it.price,
        subtotal: it.subtotal,

        cancelled_by,
        reason: finalReason || null,
        cancelled_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      };

      const row = filterDataForModel("cancelled_order_items", rawRow);

      if (Object.keys(row).length) {
        data.push(row);
      }
    }

    if (data.length) {
      await tx.cancelled_order_items.createMany({
        data,
        skipDuplicates: true,
      });
    }
  }

  return { archived: true };
}

async function archiveDeliveredOrderInternal(
  tx,
  order_id,
  { delivered_by = "SYSTEM", reason = "" } = {},
) {
  const oid = cleanOrderId(order_id);

  const hasDeliveredOrders = prismaModelExists("delivered_orders");
  const hasDeliveredItems = prismaModelExists("delivered_order_items");

  if (!hasDeliveredOrders && !hasDeliveredItems) {
    return { archived: false };
  }

  const order = await tx.orders.findUnique({
    where: {
      order_id: oid,
    },
  });

  if (!order) {
    return { archived: false };
  }

  const items = await tx.order_items.findMany({
    where: {
      order_id: oid,
    },
  });

  const finalReason = String(reason || "").trim();

  let resolvedServiceType = null;

  try {
    resolvedServiceType = await resolveOrderServiceType(oid, tx);
  } catch {
    resolvedServiceType = order.service_type
      ? String(order.service_type).trim().toUpperCase()
      : null;
  }

  if (resolvedServiceType !== "FOOD" && resolvedServiceType !== "MART") {
    resolvedServiceType = "FOOD";
  }

  const deliveredBy =
    String(delivered_by || "SYSTEM").trim().toUpperCase() || "SYSTEM";

  const delivery_fee = toNum(order.delivery_fee, 0);
  const discount_amount = toNum(order.discount_amount, 0);
  const platform_fee = toNum(order.platform_fee, 0);
  let total_amount = toNum(order.total_amount, 0);

  if (total_amount === 0) {
    const items_total = (items || []).reduce(
      (s, it) => s + toNum(it.subtotal, 0),
      0,
    );

    if (items_total > 0) {
      total_amount = Number(
        (items_total + delivery_fee - discount_amount + platform_fee).toFixed(
          2,
        ),
      );
    }
  }

  if (hasDeliveredOrders) {
    const photo =
      order.delivery_photo_url && String(order.delivery_photo_url).trim()
        ? String(order.delivery_photo_url).trim()
        : firstPhotoFromList(order.delivery_photo_urls);

    const rawRow = {
      order_id: order.order_id,
      user_id: order.user_id,
      service_type: resolvedServiceType,

      status: "DELIVERED",
      status_reason:
        finalReason || String(order.status_reason || "").trim() || null,

      delivery_fee,
      discount_amount,
      platform_fee,
      merchant_delivery_fee:
        order.merchant_delivery_fee != null
          ? Number(order.merchant_delivery_fee)
          : null,
      total_amount,

      payment_method: normalizeArchivePaymentMethod(order.payment_method),
      delivery_address:
        order.delivery_address != null ? String(order.delivery_address) : "",

      note_for_restaurant: order.note_for_restaurant ?? null,
      if_unavailable: order.if_unavailable ?? null,
      fulfillment_type: order.fulfillment_type || "Delivery",
      priority: !!order.priority,
      estimated_arrivial_time: order.estimated_arrivial_time ?? null,

      delivery_special_mode: order.delivery_special_mode
        ? String(order.delivery_special_mode).trim().toUpperCase()
        : null,

      delivery_floor_unit: order.delivery_floor_unit ?? null,
      delivery_instruction_note: order.delivery_instruction_note ?? null,
      delivery_photo_url: photo || null,

      delivered_by: deliveredBy,
      delivered_at: new Date(),

      delivery_batch_id: order.delivery_batch_id ?? null,
      delivery_driver_id: order.delivery_driver_id ?? null,
      delivery_ride_id: order.delivery_ride_id ?? null,
      delivery_status: "DELIVERED",

      original_created_at: order.created_at ?? null,
      original_updated_at: order.updated_at ?? null,
    };

    const row = filterDataForModel("delivered_orders", rawRow);

    if (Object.keys(row).length) {
      await tx.delivered_orders.deleteMany({
        where: {
          order_id: oid,
        },
      });

      await tx.delivered_orders.create({
        data: row,
      });
    }
  }

  if (hasDeliveredItems) {
    await tx.delivered_order_items.deleteMany({
      where: {
        order_id: oid,
      },
    });

    const data = [];

    for (const it of items || []) {
      const rawRow = {
        order_id: it.order_id,
        business_id: it.business_id,
        business_name: it.business_name ?? null,

        menu_id: it.menu_id,
        item_name: it.item_name ?? null,
        item_image: it.item_image ?? null,

        quantity: Number(it.quantity ?? 1),
        price: Number(it.price ?? 0),
        subtotal: Number(it.subtotal ?? 0),

        platform_fee: Number(it.platform_fee ?? 0),
        delivery_fee: Number(it.delivery_fee ?? 0),
      };

      const row = filterDataForModel("delivered_order_items", rawRow);

      if (Object.keys(row).length) {
        data.push(row);
      }
    }

    if (data.length) {
      await tx.delivered_order_items.createMany({
        data,
      });
    }
  }

  return { archived: true };
}

async function deleteOrderFromMainTablesInternal(tx, order_id) {
  const oid = cleanOrderId(order_id);

  await tx.order_items.deleteMany({
    where: {
      order_id: oid,
    },
  });

  await tx.orders.deleteMany({
    where: {
      order_id: oid,
    },
  });
}

async function trimDeliveredOrdersForUser(tx, userId, keep = 10) {
  if (!prismaModelExists("delivered_orders")) {
    return { trimmed: 0 };
  }

  const uid = Number(userId);
  const keepCount = Math.max(Number(keep) || 10, 0);

  if (!Number.isFinite(uid) || uid <= 0) {
    return { trimmed: 0 };
  }

  const orderBy = [];

  if (hasField("delivered_orders", "delivered_at")) {
    orderBy.push({ delivered_at: "desc" });
  }

  if (hasField("delivered_orders", "delivered_id")) {
    orderBy.push({ delivered_id: "desc" });
  }

  if (!orderBy.length) {
    orderBy.push({ order_id: "desc" });
  }

  const oldRows = await tx.delivered_orders.findMany({
    where: {
      user_id: uid,
    },
    select: {
      order_id: true,
    },
    orderBy,
    skip: keepCount,
    take: 100000,
  });

  if (!oldRows.length) {
    return { trimmed: 0 };
  }

  const oldIds = oldRows.map((r) => r.order_id);

  const result = await tx.delivered_orders.deleteMany({
    where: {
      user_id: uid,
      order_id: {
        in: oldIds,
      },
    },
  });

  return {
    trimmed: result.count || 0,
  };
}

/* ================= CANCEL + ARCHIVE + DELETE ================= */

async function cancelAndArchiveOrder(
  order_id,
  {
    cancelled_by = "SYSTEM",
    reason = "",
    cancel_reason = "",
    onlyIfStatus = null,
    expectedUserId = null,
  } = {},
) {
  const oid = cleanOrderId(order_id);

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.orders.findUnique({
        where: {
          order_id: oid,
        },
        select: {
          order_id: true,
          user_id: true,
          status: true,
        },
      });

      if (!row) {
        return { ok: false, code: "NOT_FOUND" };
      }

      const user_id = Number(row.user_id);
      const current = String(row.status || "").toUpperCase();

      if (expectedUserId != null && Number(expectedUserId) !== user_id) {
        return { ok: false, code: "FORBIDDEN" };
      }

      if (onlyIfStatus && current !== String(onlyIfStatus).toUpperCase()) {
        return {
          ok: false,
          code: "SKIPPED",
          current_status: current,
        };
      }

      const bizRows = await tx.order_items.findMany({
        where: {
          order_id: oid,
        },
        select: {
          business_id: true,
        },
        distinct: ["business_id"],
      });

      const business_ids = bizRows
        .map((x) => Number(x.business_id))
        .filter((n) => Number.isFinite(n) && n > 0);

      const finalReason = String(reason || cancel_reason || "").trim();

      const data = {
        status: "CANCELLED",
        updated_at: new Date(),
      };

      if (await ensureStatusReasonSupport()) {
        data.status_reason = finalReason;
      }

      await tx.orders.updateMany({
        where: {
          order_id: oid,
        },
        data,
      });

      await archiveCancelledOrderInternal(tx, oid, {
        cancelled_by,
        reason: finalReason,
      });

      await deleteOrderFromMainTablesInternal(tx, oid);

      return {
        ok: true,
        user_id,
        business_ids,
        status: "CANCELLED",
      };
    });
  } catch (e) {
    throw e;
  }
}

async function cancelIfStillPending(order_id, reason) {
  const out = await cancelAndArchiveOrder(order_id, {
    cancelled_by: "SYSTEM",
    reason,
    onlyIfStatus: "PENDING",
  });

  return !!out?.ok;
}

/* ================= DELIVERED: COMPLETE + CAPTURE + ARCHIVE + DELETE ================= */

async function completeAndArchiveDeliveredOrder(
  order_id,
  { delivered_by = "SYSTEM", reason = "", capture_at = "DELIVERED" } = {},
) {
  const oid = cleanOrderId(order_id);

  const CAPTURE_AT = String(capture_at ?? process.env.CAPTURE_AT ?? "DELIVERED")
    .trim()
    .toUpperCase();

  const CAPTURE_DISABLED = new Set(["SKIP", "NONE", "OFF", "DISABLED"]);

  let prefetchedIds = [];

  if (!CAPTURE_DISABLED.has(CAPTURE_AT) && CAPTURE_AT === "DELIVERED") {
    try {
      const pre = await prisma.orders.findUnique({
        where: {
          order_id: oid,
        },
        select: {
          payment_method: true,
        },
      });

      const pm = pre?.payment_method
        ? String(pre.payment_method).trim().toUpperCase()
        : null;

      if (pm === "WALLET") {
        prefetchedIds = await prefetchTxnIdsBatch(3);
      } else if (pm === "COD") {
        prefetchedIds = await prefetchTxnIdsBatch(2);
      }
    } catch (e) {
      return {
        ok: false,
        code: "CAPTURE_FAILED",
        error: e?.message || "ID prefetch failed",
      };
    }
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT order_id, user_id, status, payment_method
         FROM orders
        WHERE order_id = ?
        FOR UPDATE`,
      [oid],
    );

    if (!row) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const user_id = Number(row.user_id);
    const current = String(row.status || "").toUpperCase();
    const payMethod = String(row.payment_method || "").toUpperCase();

    if (current === "CANCELLED") {
      await conn.rollback();

      return {
        ok: false,
        code: "SKIPPED",
        current_status: current,
      };
    }

    const [bizRows] = await conn.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [oid],
    );

    const business_ids = bizRows
      .map((x) => Number(x.business_id))
      .filter((n) => Number.isFinite(n) && n > 0);

    const finalReason = String(reason || "").trim();

    const [[order]] = await conn.query(
      `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
      [oid],
    );

    const [items] = await conn.query(
      `SELECT * FROM order_items WHERE order_id = ?`,
      [oid],
    );

    let capture = {
      captured: false,
      skipped: true,
      payment_method: payMethod,
    };

    if (!CAPTURE_DISABLED.has(CAPTURE_AT) && CAPTURE_AT === "DELIVERED") {
      try {
        if (payMethod === "WALLET") {
          capture = await captureOrderFundsWithConn(conn, oid, prefetchedIds);
        } else if (payMethod === "COD") {
          capture = await captureOrderCODFeeWithConn(conn, oid, prefetchedIds);
        }
      } catch (e) {
        await conn.rollback();

        return {
          ok: false,
          code: "CAPTURE_FAILED",
          error: e?.message || "Capture error",
        };
      }
    }

    const hasReason = await ensureStatusReasonSupport(conn);

    if (hasReason) {
      await conn.query(
        `UPDATE orders
            SET status='DELIVERED', status_reason=?, updated_at=NOW()
          WHERE order_id=?`,
        [finalReason, oid],
      );
    } else {
      await conn.query(
        `UPDATE orders
            SET status='DELIVERED', updated_at=NOW()
          WHERE order_id=?`,
        [oid],
      );
    }

    const extras = await ensureDeliveryExtrasSupport(conn);

    if (extras.hasDeliveredAt) {
      await conn.query(
        `UPDATE orders
            SET delivered_at = COALESCE(delivered_at, NOW())
          WHERE order_id = ?
          LIMIT 1`,
        [oid],
      );
    }

    if (extras.hasDeliveryStatus) {
      await conn.query(
        `UPDATE orders
            SET delivery_status = 'DELIVERED'
          WHERE order_id = ?
          LIMIT 1`,
        [oid],
      );
    }

    let pointsInfo = null;

    try {
      pointsInfo = await awardPointsForCompletedOrderWithConn(conn, oid);
    } catch (e) {
      pointsInfo = {
        awarded: false,
        reason: "points_error",
        error: e?.message,
      };
    }

    try {
      const deliveredAt = order?.delivered_at
        ? new Date(order.delivered_at)
        : new Date();

      const primaryBiz = items?.[0]?.business_id
        ? Number(items[0].business_id)
        : null;

      if (primaryBiz) {
        const totalAmount = Number(order?.total_amount || 0);
        const platformFeeTotal = Number(order?.platform_fee || 0);

        const USER_SHARE = Number(process.env.PLATFORM_USER_SHARE ?? 0.5);

        const safeUserShare =
          Number.isFinite(USER_SHARE) && USER_SHARE >= 0 && USER_SHARE <= 1
            ? USER_SHARE
            : 0.5;

        const platform_fee_user = Number(
          (platformFeeTotal * safeUserShare).toFixed(2),
        );

        const merchantEarningAmount = Number(
          (totalAmount - platform_fee_user).toFixed(2),
        );

        await insertMerchantEarningWithConn(conn, {
          business_id: primaryBiz,
          order_id: oid,
          total_amount: merchantEarningAmount > 0 ? merchantEarningAmount : 0,
          dateObj: deliveredAt,
        });
      }
    } catch (e) {
      console.error("[merchant_earnings insert failed]", e?.message || e);
    }

    try {
      let ownerType = null;

      try {
        ownerType = await resolveOrderServiceType(oid);
      } catch {}

      ownerType = String(ownerType || "FOOD").toUpperCase();

      if (ownerType !== "FOOD" && ownerType !== "MART") {
        ownerType = "FOOD";
      }

      const deliveredAt = order?.delivered_at
        ? new Date(order.delivered_at)
        : new Date();

      const [[u]] = await conn.query(
        `SELECT user_name, phone FROM users WHERE user_id = ? LIMIT 1`,
        [user_id],
      );

      const customerName =
        (u?.user_name && String(u.user_name).trim()) || `User ${user_id}`;

      const customerPhone = u?.phone ? String(u.phone).trim() : null;

      const primaryBizId = items?.[0]?.business_id
        ? Number(items[0].business_id)
        : null;

      let businessName = null;

      if (primaryBizId) {
        const [[mbd]] = await conn.query(
          `SELECT business_name
             FROM merchant_business_details
            WHERE business_id = ?
            LIMIT 1`,
          [primaryBizId],
        );

        businessName =
          (mbd?.business_name && String(mbd.business_name).trim()) ||
          (items?.[0]?.business_name
            ? String(items[0].business_name).trim()
            : null) ||
          `Business ${primaryBizId}`;
      }

      const { summary, totalQty } = buildItemsSummary(items);

      const totalAmount = Number(order?.total_amount || 0);
      const platformFee = Number(order?.platform_fee || 0);

      const detailsObj = {
        order: {
          id: oid,
          status: "DELIVERED",
          placed_at: deliveredAt,
          owner_type: ownerType,
          source: "delivered",
        },
        customer: {
          id: user_id,
          name: customerName,
          phone: customerPhone,
        },
        business: {
          id: primaryBizId,
          name: businessName,
          owner_type: ownerType,
        },
        items: {
          summary: summary || "",
          total_quantity: Number(totalQty || 0),
        },
        amounts: {
          total_amount: totalAmount,
          platform_fee: platformFee,
          revenue_earned: platformFee,
          tax: 0,
        },
        payment: {
          method: payMethod,
        },
      };

      if (primaryBizId) {
        await insertFoodMartRevenueWithConn(conn, {
          order_id: oid,
          user_id,
          business_id: Number(primaryBizId),
          owner_type: ownerType,
          source: "delivered",
          status: "DELIVERED",
          placed_at: deliveredAt,
          payment_method: normalizeArchivePaymentMethod(payMethod),
          total_amount: totalAmount,
          platform_fee: platformFee,
          revenue_earned: platformFee,
          tax: 0,
          customer_name: customerName,
          customer_phone: customerPhone,
          business_name: businessName,
          items_summary: summary || "",
          total_quantity: Number(totalQty || 0),
          details_json: JSON.stringify(detailsObj),
        });
      }
    } catch (e) {
      console.error("[food_mart_revenue insert failed]", e?.message);
    }

    try {
      const totalAmount = Number(order?.total_amount || 0);
      const platformFeeTotal = Number(order?.platform_fee || 0);

      const USER_SHARE = Number(process.env.PLATFORM_USER_SHARE ?? 0.5);

      const safeUserShare =
        Number.isFinite(USER_SHARE) && USER_SHARE >= 0 && USER_SHARE <= 1
          ? USER_SHARE
          : 0.5;

      const platform_fee_user_raw = platformFeeTotal * safeUserShare;
      const platform_fee_user = Number(platform_fee_user_raw.toFixed(2));

      const platform_fee_merchant = Number(
        (platformFeeTotal - platform_fee_user).toFixed(2),
      );

      const order_amount = Number((totalAmount - platform_fee_user).toFixed(2));

      const primaryBizId =
        (items?.[0]?.business_id ? Number(items[0].business_id) : null) ||
        (business_ids?.[0] ? Number(business_ids[0]) : null) ||
        null;

      capture = {
        ...(capture || {}),
        order_id: oid,
        user_id,
        payment_method: normalizeArchivePaymentMethod(payMethod),

        business_id:
          capture?.business_id != null ? capture.business_id : primaryBizId,

        order_amount:
          capture?.order_amount != null
            ? Number(capture.order_amount)
            : order_amount,

        platform_fee_user:
          capture?.platform_fee_user != null
            ? Number(capture.platform_fee_user)
            : platform_fee_user,

        platform_fee_merchant:
          capture?.platform_fee_merchant != null
            ? Number(capture.platform_fee_merchant)
            : platform_fee_merchant,
      };
    } catch (e) {
      console.error("[capture enrich failed]", e?.message || e);

      capture = {
        ...(capture || {}),
        order_id: oid,
        user_id,
        payment_method: normalizeArchivePaymentMethod(payMethod),
      };
    }

    await archiveDeliveredOrderInternalWithConn(conn, oid, {
      delivered_by,
      reason: finalReason,
    });

    await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [oid]);
    await conn.query(`DELETE FROM orders WHERE order_id = ?`, [oid]);

    await trimDeliveredOrdersForUserWithConn(conn, user_id, 10);

    await conn.commit();

    return {
      ok: true,
      user_id,
      business_ids,
      status: "DELIVERED",
      points: pointsInfo,
      capture,
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    throw e;
  } finally {
    conn.release();
  }
}

/* ======================================================================
   TEMPORARY CONNECTION-BASED DELIVERED ARCHIVE HELPERS
====================================================================== */

async function archiveDeliveredOrderInternalWithConn(
  conn,
  order_id,
  { delivered_by = "SYSTEM", reason = "" } = {},
) {
  const oid = cleanOrderId(order_id);

  const [[order]] = await conn.query(
    `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
    [oid],
  );

  if (!order) {
    return { archived: false };
  }

  const [items] = await conn.query(
    `SELECT * FROM order_items WHERE order_id = ?`,
    [oid],
  );

  const finalReason = String(reason || "").trim();

  let resolvedServiceType = null;

  try {
    resolvedServiceType = await resolveOrderServiceType(oid);
  } catch {
    resolvedServiceType = order.service_type
      ? String(order.service_type).trim().toUpperCase()
      : null;
  }

  if (resolvedServiceType !== "FOOD" && resolvedServiceType !== "MART") {
    resolvedServiceType = "FOOD";
  }

  const deliveredBy =
    String(delivered_by || "SYSTEM").trim().toUpperCase() || "SYSTEM";

  const delivery_fee = Number(order.delivery_fee || 0);
  const discount_amount = Number(order.discount_amount || 0);
  const platform_fee = Number(order.platform_fee || 0);
  let total_amount = Number(order.total_amount || 0);

  if (total_amount === 0) {
    const items_total = (items || []).reduce(
      (s, it) => s + Number(it.subtotal || 0),
      0,
    );

    if (items_total > 0) {
      total_amount = Number(
        (items_total + delivery_fee - discount_amount + platform_fee).toFixed(
          2,
        ),
      );
    }
  }

  const photo =
    order.delivery_photo_url && String(order.delivery_photo_url).trim()
      ? String(order.delivery_photo_url).trim()
      : firstPhotoFromList(order.delivery_photo_urls);

  const deliveredRow = filterDataForModel("delivered_orders", {
    order_id: order.order_id,
    user_id: order.user_id,
    service_type: resolvedServiceType,

    status: "DELIVERED",
    status_reason:
      finalReason || String(order.status_reason || "").trim() || null,

    delivery_fee,
    discount_amount,
    platform_fee,
    merchant_delivery_fee:
      order.merchant_delivery_fee != null
        ? Number(order.merchant_delivery_fee)
        : null,
    total_amount,

    payment_method: normalizeArchivePaymentMethod(order.payment_method),
    delivery_address:
      order.delivery_address != null ? String(order.delivery_address) : "",

    note_for_restaurant: order.note_for_restaurant ?? null,
    if_unavailable: order.if_unavailable ?? null,
    fulfillment_type: order.fulfillment_type || "Delivery",
    priority: !!order.priority,
    estimated_arrivial_time: order.estimated_arrivial_time ?? null,

    delivery_special_mode: order.delivery_special_mode
      ? String(order.delivery_special_mode).trim().toUpperCase()
      : null,

    delivery_floor_unit: order.delivery_floor_unit ?? null,
    delivery_instruction_note: order.delivery_instruction_note ?? null,
    delivery_photo_url: photo || null,

    delivered_by: deliveredBy,
    delivered_at: new Date(),

    delivery_batch_id: order.delivery_batch_id ?? null,
    delivery_driver_id: order.delivery_driver_id ?? null,
    delivery_ride_id: order.delivery_ride_id ?? null,
    delivery_status: "DELIVERED",

    original_created_at: order.created_at ?? null,
    original_updated_at: order.updated_at ?? null,
  });

  if (Object.keys(deliveredRow).length) {
    const fields = Object.keys(deliveredRow);
    const colSql = fields.map((f) => `\`${f}\``).join(", ");
    const placeholders = fields.map(() => "?").join(", ");
    const values = fields.map((k) => deliveredRow[k]);

    const updateFields = fields.filter((f) => f !== "order_id");

    const updateSql = updateFields.length
      ? updateFields.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(", ")
      : "`order_id`=`order_id`";

    await conn.query(
      `INSERT INTO delivered_orders (${colSql})
       VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updateSql}`,
      values,
    );
  }

  await conn.query(`DELETE FROM delivered_order_items WHERE order_id = ?`, [
    oid,
  ]);

  for (const it of items || []) {
    const itemRow = filterDataForModel("delivered_order_items", {
      order_id: it.order_id,
      business_id: it.business_id,
      business_name: it.business_name ?? null,

      menu_id: it.menu_id,
      item_name: it.item_name ?? null,
      item_image: it.item_image ?? null,

      quantity: Number(it.quantity ?? 1),
      price: Number(it.price ?? 0),
      subtotal: Number(it.subtotal ?? 0),

      platform_fee: Number(it.platform_fee ?? 0),
      delivery_fee: Number(it.delivery_fee ?? 0),
    });

    if (!Object.keys(itemRow).length) continue;

    const fields = Object.keys(itemRow);
    const colSql = fields.map((f) => `\`${f}\``).join(", ");
    const placeholders = fields.map(() => "?").join(", ");
    const values = fields.map((k) => itemRow[k]);

    await conn.query(
      `INSERT INTO delivered_order_items (${colSql}) VALUES (${placeholders})`,
      values,
    );
  }

  return { archived: true };
}

async function trimDeliveredOrdersForUserWithConn(conn, userId, keep = 10) {
  const uid = Number(userId);

  if (!Number.isFinite(uid) || uid <= 0) {
    return { trimmed: 0 };
  }

  const orderBy = hasField("delivered_orders", "delivered_at")
    ? `ORDER BY delivered_at DESC${
        hasField("delivered_orders", "delivered_id")
          ? ", delivered_id DESC"
          : ""
      }`
    : hasField("delivered_orders", "delivered_id")
      ? `ORDER BY delivered_id DESC`
      : `ORDER BY order_id DESC`;

  const [oldRows] = await conn.query(
    `
    SELECT order_id
      FROM delivered_orders
     WHERE user_id = ?
     ${orderBy}
     LIMIT ?, 100000
     FOR UPDATE
    `,
    [uid, Number(keep) || 10],
  );

  if (!oldRows.length) {
    return { trimmed: 0 };
  }

  const oldIds = oldRows.map((r) => r.order_id);

  const [del] = await conn.query(
    `DELETE FROM delivered_orders WHERE user_id = ? AND order_id IN (?)`,
    [uid, oldIds],
  );

  return {
    trimmed: del.affectedRows || 0,
  };
}

module.exports = {
  cancelAndArchiveOrder,
  cancelIfStillPending,
  completeAndArchiveDeliveredOrder,
};