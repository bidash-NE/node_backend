// models/orderModels.js
const db = require("../config/db");
const axios = require("axios");

/* ======================= CONFIG ======================= */
const ADMIN_WALLET_ID = "NET000001"; // admin wallet

// 50/50 platform fee sharing
const PLATFORM_USER_SHARE = 0.5;
const PLATFORM_MERCHANT_SHARE = 0.5;

// External ID services (all POST)
const IDS_BOTH_URL =
  process.env.WALLET_IDS_BOTH_URL || "https://grab.newedge.bt/wallet/ids/both";
const IDS_TXN_URL =
  process.env.WALLET_IDS_TXN_URL ||
  "https://grab.newedge.bt/wallets/ids/transaction";
const IDS_JRN_URL =
  process.env.WALLET_IDS_JRN_URL ||
  "https://grab.newedge.bt/wallets/ids/journal";

/* ======================= UTILS ======================= */
function generateOrderId() {
  const n = Math.floor(10000000 + Math.random() * 90000000);
  return `ORD-${n}`;
}

let _hasStatusReason = null;
async function ensureStatusReasonSupport() {
  if (_hasStatusReason !== null) return _hasStatusReason;
  const [rows] = await db.query(`
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'status_reason'
  `);
  _hasStatusReason = rows.length > 0;
  return _hasStatusReason;
}

const fmtNu = (n) => Number(n || 0).toFixed(2);

/* ================= HTTP & ID SERVICE HELPERS ================= */
async function postJson(url, body = {}, timeout = 8000) {
  const { data } = await axios.post(url, body, {
    timeout,
    headers: { "Content-Type": "application/json" },
  });
  return data;
}

function extractIdsShape(payload) {
  const p = payload?.data ? payload.data : payload;

  let txn_ids = null;
  if (Array.isArray(p?.transaction_ids) && p.transaction_ids.length >= 2) {
    txn_ids = [String(p.transaction_ids[0]), String(p.transaction_ids[1])];
  } else if (Array.isArray(p?.txn_ids) && p.txn_ids.length >= 2) {
    txn_ids = [String(p.txn_ids[0]), String(p.txn_ids[1])];
  }

  const single_txn =
    p?.txn_id || p?.txn || p?.transaction_id || p?.transactionId || null;

  const journal =
    p?.journal_id || p?.journal || p?.journal_code || p?.journalCode || null;

  return { txn_ids, single_txn, journal_id: journal || null };
}

async function fetchTxnAndJournalIds() {
  try {
    const data = await postJson(IDS_BOTH_URL, {});
    const { txn_ids, journal_id, single_txn } = extractIdsShape(data);
    if (txn_ids && txn_ids.length >= 2) {
      return { dr_id: txn_ids[0], cr_id: txn_ids[1], journal_id };
    }
    if (single_txn) {
      const d2 = await postJson(IDS_TXN_URL, {});
      const { single_txn: single2 } = extractIdsShape(d2);
      return { dr_id: single_txn, cr_id: single2 || single_txn, journal_id };
    }
  } catch (_) {}

  let dr_id = null,
    cr_id = null,
    journal_id = null;
  try {
    journal_id = extractIdsShape(await postJson(IDS_JRN_URL, {})).journal_id;
  } catch (_) {}
  try {
    dr_id = extractIdsShape(await postJson(IDS_TXN_URL, {})).single_txn;
  } catch (_) {}
  try {
    cr_id = extractIdsShape(await postJson(IDS_TXN_URL, {})).single_txn;
  } catch (_) {}

  if (!dr_id || !cr_id) {
    throw new Error(
      "Unable to fetch transaction IDs from wallet ID service (POST)."
    );
  }
  return { dr_id, cr_id, journal_id };
}

/* ================= WALLET LOOKUPS ================= */
async function getBuyerWalletByUserId(user_id, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `SELECT id, wallet_id, user_id, amount, status FROM wallets WHERE user_id = ? LIMIT 1`,
    [user_id]
  );
  return rows[0] || null;
}

async function getAdminWallet(conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `SELECT id, wallet_id, user_id, amount, status FROM wallets WHERE wallet_id = ? LIMIT 1`,
    [ADMIN_WALLET_ID]
  );
  return rows[0] || null;
}

async function getMerchantWalletByBusinessId(business_id, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT w.id, w.wallet_id, w.user_id, w.amount, w.status
      FROM merchant_business_details m
      JOIN wallets w ON w.user_id = m.user_id
     WHERE m.business_id = ? 
     LIMIT 1
    `,
    [business_id]
  );
  return rows[0] || null;
}

/* ================= USER NOTIFICATIONS ================= */
async function insertUserNotification(
  conn,
  { user_id, title, message, type = "wallet", data = null, status = "unread" }
) {
  await conn.query(
    `INSERT INTO notifications (user_id, type, title, message, data, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      user_id,
      type,
      title,
      message,
      data ? JSON.stringify(data) : null,
      status === "read" ? "read" : "unread",
    ]
  );
}

function humanOrderStatus(status) {
  const s = String(status || "").toUpperCase();
  switch (s) {
    case "PENDING":
      return "pending";
    case "CONFIRMED":
      return "accepted by the store";
    case "PREPARING":
      return "being prepared";
    case "READY":
      return "ready for pickup";
    case "OUT_FOR_DELIVERY":
      return "out for delivery";
    case "COMPLETED":
      return "completed";
    case "CANCELLED":
      return "cancelled";
    case "DECLINED":
      return "declined by the store";
    default:
      return s.toLowerCase();
  }
}

async function addUserOrderStatusNotificationInternal(
  user_id,
  order_id,
  status,
  reason = "",
  conn = null
) {
  const dbh = conn || db;
  const normalized = String(status || "").toUpperCase();
  const trimmedReason = String(reason || "").trim();

  let message;
  if (normalized === "CONFIRMED") {
    message = `Your order ${order_id} is accepted successfully.`;
  } else {
    const nice = humanOrderStatus(normalized);
    message = `Your order ${order_id} is now ${nice}.`;
  }

  if (trimmedReason) {
    message += ` Reason: ${trimmedReason}`;
  }

  await insertUserNotification(dbh, {
    user_id,
    type: "order_status",
    title: "Order update",
    message,
    data: {
      order_id,
      status: normalized,
      reason: trimmedReason || null,
    },
    status: "unread",
  });
}

async function addUserUnavailableItemNotificationInternal(
  user_id,
  order_id,
  changes,
  final_total_amount = null,
  conn = null
) {
  const dbh = conn || db;
  const removed = Array.isArray(changes?.removed) ? changes.removed : [];
  const replaced = Array.isArray(changes?.replaced) ? changes.replaced : [];

  const lines = [];

  if (removed.length) {
    const names = removed
      .map((x) => x.item_name || x.menu_id)
      .filter(Boolean)
      .join(", ");
    lines.push(
      names
        ? `Removed items: ${names}.`
        : `Some unavailable items were removed from your order.`
    );
  }

  if (replaced.length) {
    const names = replaced
      .map((x) => x.new?.item_name || x.old?.item_name || x.old?.menu_id)
      .filter(Boolean)
      .join(", ");
    lines.push(
      names
        ? `Replaced items: ${names}.`
        : `Some unavailable items were replaced with alternatives.`
    );
  }

  if (!lines.length) return;

  if (final_total_amount != null) {
    lines.push(
      `Your final payable amount for this order is Nu. ${fmtNu(
        final_total_amount
      )}.`
    );
  }

  const message = lines.join(" ");

  await insertUserNotification(dbh, {
    user_id,
    type: "order_unavailable_items",
    title: `Items updated in order ${order_id}`,
    message,
    data: {
      order_id,
      changes: { removed, replaced },
      final_total_amount:
        final_total_amount != null ? Number(final_total_amount) : null,
    },
    status: "unread",
  });
}

async function addUserWalletDebitNotificationInternal(
  user_id,
  order_id,
  order_amount,
  platform_fee,
  method,
  conn = null
) {
  const dbh = conn || db;
  const payMethod = String(method || "").toUpperCase();
  const orderAmt = Number(order_amount || 0);
  const feeAmt = Number(platform_fee || 0); // user share only

  if (!(orderAmt > 0 || feeAmt > 0)) return;

  let message;
  if (payMethod === "WALLET") {
    message = `Your order ${order_id} is accepted successfully. Nu. ${fmtNu(
      orderAmt
    )} has been deducted from your wallet for the order and Nu. ${fmtNu(
      feeAmt
    )} as platform fee (your share).`;
  } else {
    message = `Order ${order_id}: Nu. ${fmtNu(
      feeAmt
    )} was deducted from your wallet as platform fee (your share).`;
  }

  await insertUserNotification(dbh, {
    user_id,
    type: "wallet_debit",
    title: "Wallet deduction",
    message,
    data: {
      order_id,
      order_amount: orderAmt,
      platform_fee: feeAmt,
      method: payMethod,
    },
    status: "unread",
  });
}

/* ================= POINT SYSTEM HELPERS (USERS) ================= */

/**
 * Fetch single active point rule:
 *  - min_amount_per_point  (e.g. 100)
 *  - point_to_award        (e.g. 1)
 */
async function getActivePointRule(conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT point_id, min_amount_per_point, point_to_award, is_active
      FROM point_system
     WHERE is_active = 1
     ORDER BY created_at DESC
     LIMIT 1
  `
  );
  return rows[0] || null;
}

/**
 * Check if points have already been awarded for an order
 * by looking for an existing notification of type 'points_awarded'
 * with data.order_id = :order_id
 */
async function hasPointsAwardNotification(order_id, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT id
      FROM notifications
     WHERE type = 'points_awarded'
       AND JSON_EXTRACT(data, '$.order_id') = ?
     LIMIT 1
  `,
    [order_id]
  );
  return rows.length > 0;
}

/**
 * Award points to the user for a COMPLETED order:
 *  - Uses active point_system rule
 *  - Points = floor(total_amount / min_amount_per_point) * point_to_award
 *  - Updates users.points
 *  - Inserts notification (type = 'points_awarded')
 */
async function awardPointsForCompletedOrder(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Fetch order and ensure COMPLETED
    const [[order]] = await conn.query(
      `
      SELECT user_id, total_amount, status
        FROM orders
       WHERE order_id = ?
       LIMIT 1
    `,
      [order_id]
    );

    if (!order) {
      await conn.rollback();
      return { awarded: false, reason: "order_not_found" };
    }

    const status = String(order.status || "").toUpperCase();
    if (status !== "COMPLETED") {
      await conn.rollback();
      return { awarded: false, reason: "not_completed" };
    }

    // 2) Ensure no duplicate awarding
    const already = await hasPointsAwardNotification(order_id, conn);
    if (already) {
      await conn.rollback();
      return { awarded: false, reason: "already_awarded" };
    }

    // 3) Fetch active rule
    const rule = await getActivePointRule(conn);
    if (!rule) {
      await conn.rollback();
      return { awarded: false, reason: "no_active_rule" };
    }

    const totalAmount = Number(order.total_amount || 0);
    const minAmount = Number(rule.min_amount_per_point || 0);
    const perPoint = Number(rule.point_to_award || 0);

    if (!(totalAmount > 0 && minAmount > 0 && perPoint > 0)) {
      await conn.rollback();
      return { awarded: false, reason: "invalid_rule_or_amount" };
    }

    // 4) Compute points
    const units = Math.floor(totalAmount / minAmount);
    const points = units * perPoint;

    if (points <= 0) {
      await conn.rollback();
      return { awarded: false, reason: "computed_zero" };
    }

    // 5) Update user points
    await conn.query(`UPDATE users SET points = points + ? WHERE user_id = ?`, [
      points,
      order.user_id,
    ]);

    // 6) Insert notification into notifications table
    const msg = `You earned ${points} points for order ${order_id} (Nu. ${fmtNu(
      totalAmount
    )} spent).`;

    await insertUserNotification(conn, {
      user_id: order.user_id,
      type: "points_awarded",
      title: "Points earned",
      message: msg,
      data: {
        order_id,
        points_awarded: points,
        total_amount: totalAmount,
        min_amount_per_point: minAmount,
        point_to_award: perPoint,
        rule_id: rule.point_id,
      },
      status: "unread",
    });

    await conn.commit();

    return {
      awarded: true,
      points_awarded: points,
      total_amount: totalAmount,
      rule_id: rule.point_id,
      min_amount_per_point: minAmount,
      point_to_award: perPoint,
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

/* ================= OTHER HELPERS ================= */
function parseDeliveryAddress(val) {
  if (val == null) return null;
  if (typeof val === "object") return val;
  const str = String(val || "").trim();
  if (!str) return null;
  try {
    const obj = JSON.parse(str);
    return {
      address: obj.address ?? obj.addr ?? "",
      lat: typeof obj.lat === "number" ? obj.lat : Number(obj.lat ?? NaN),
      lng: typeof obj.lng === "number" ? obj.lng : Number(obj.lng ?? NaN),
    };
  } catch {
    return { address: str, lat: null, lng: null };
  }
}

/* ================= CAPTURE HELPERS ================= */
async function captureExists(order_id, capture_type, conn = null) {
  const dbh = conn || db;
  const [[row]] = await dbh.query(
    `SELECT order_id FROM order_wallet_captures WHERE order_id = ? AND capture_type = ? LIMIT 1`,
    [order_id, capture_type]
  );
  return !!row;
}

/**
 * computeBusinessSplit
 * - delivery_fee is order-level, allocated proportionally by subtotal share
 * - platform_fee is order-level, allocated proportionally by (subtotal+delivery_share)
 * - merchant_delivery_fee is NOT used here; it’s just stored for later (driver payout)
 */
async function computeBusinessSplit(order_id, conn = null) {
  const dbh = conn || db;

  const [[order]] = await dbh.query(
    `SELECT order_id,total_amount,platform_fee,delivery_fee,merchant_delivery_fee
       FROM orders WHERE order_id = ? LIMIT 1`,
    [order_id]
  );
  if (!order) throw new Error("Order not found while computing split");

  const [items] = await dbh.query(
    `SELECT business_id, subtotal
       FROM order_items
      WHERE order_id = ?
      ORDER BY menu_id ASC`,
    [order_id]
  );
  if (!items.length) throw new Error("Order has no items");

  // subtotal per business
  const byBiz = new Map();
  for (const it of items) {
    const part = Number(it.subtotal || 0);
    byBiz.set(it.business_id, (byBiz.get(it.business_id) || 0) + part);
  }

  const subtotalTotal = Array.from(byBiz.values()).reduce((s, v) => s + v, 0);
  const deliveryTotal = Number(order.delivery_fee || 0);
  const feeTotal = Number(order.platform_fee || 0);
  const primaryBizId = items[0].business_id;

  const primarySub = byBiz.get(primaryBizId) || 0;

  // allocate delivery proportionally
  const primaryDelivery =
    subtotalTotal > 0
      ? deliveryTotal * (primarySub / subtotalTotal)
      : deliveryTotal;

  const baseTotal = subtotalTotal + deliveryTotal;
  const primaryBase = primarySub + primaryDelivery;

  if (byBiz.size === 1) {
    return {
      business_id: primaryBizId,
      total_amount: Number(primaryBase.toFixed(2)), // items + delivery
      platform_fee: feeTotal, // full fee for single merchant
      net_to_merchant: Number((primaryBase - feeTotal).toFixed(2)),
    };
  }

  // multi-biz: fee share based on base share
  const primaryFeeShare =
    baseTotal > 0 ? feeTotal * (primaryBase / baseTotal) : 0;

  return {
    business_id: primaryBizId,
    total_amount: Number(primaryBase.toFixed(2)),
    platform_fee: Number(primaryFeeShare.toFixed(2)),
    net_to_merchant: Number((primaryBase - primaryFeeShare).toFixed(2)),
  };
}

/**
 * Record wallet transfer as DR & CR rows.
 */
async function recordWalletTransfer(
  conn,
  { fromId, toId, amount, order_id, note = null }
) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return null;

  const [dr] = await conn.query(
    `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
    [amt, fromId, amt]
  );
  if (!dr.affectedRows)
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);

  await conn.query(
    `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
    [amt, toId]
  );

  const { dr_id, cr_id, journal_id } = await fetchTxnAndJournalIds();

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
    [dr_id, journal_id || null, fromId, toId, amt, note]
  );

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
    [cr_id, journal_id || null, fromId, toId, amt, note]
  );

  return { dr_txn_id: dr_id, cr_txn_id: cr_id, journal_id };
}

/* ================= PUBLIC CAPTURE APIS ================= */
/**
 * WALLET orders:
 * - Customer pays: (items + delivery) + 50% platform fee
 * - Merchant pays: 50% platform fee from their wallet
 * - Admin receives: 100% platform fee
 * - merchant_delivery_fee is not touched here; used later for driver payout
 */
async function captureOrderFunds(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (await captureExists(order_id, "WALLET_FULL", conn)) {
      await conn.commit();
      return { captured: false, alreadyCaptured: true };
    }

    const [[order]] = await conn.query(
      `SELECT user_id, total_amount, platform_fee, payment_method
         FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!order) throw new Error("Order not found for capture");

    if (String(order.payment_method || "WALLET").toUpperCase() !== "WALLET") {
      await conn.commit();
      return {
        captured: false,
        skipped: true,
        reason: "payment_method != WALLET",
      };
    }

    const split = await computeBusinessSplit(order_id, conn);

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merch) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const baseToMerchant = Number(split.total_amount || 0); // items + delivery
    const feeForPrimary = Number(split.platform_fee || 0);

    const userFee =
      feeForPrimary > 0 ? Number((feeForPrimary / 2).toFixed(2)) : 0;
    const merchFee = feeForPrimary - userFee;

    // buyer must have base + userFee
    const needFromBuyer = baseToMerchant + userFee;

    const [[freshBuyer]] = await conn.query(
      `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
      [buyer.id]
    );
    if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
      throw new Error("Insufficient wallet balance during capture");
    }

    if (merchFee > 0) {
      const [[freshMerch]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [merch.id]
      );
      if (!freshMerch || Number(freshMerch.amount) < merchFee) {
        throw new Error(
          "Insufficient merchant wallet balance for platform fee share."
        );
      }
    }

    // 1) BASE ORDER AMOUNT: USER → MERCHANT
    const tOrder = await recordWalletTransfer(conn, {
      fromId: buyer.wallet_id,
      toId: merch.wallet_id,
      amount: baseToMerchant,
      order_id,
      note: `Order base (items+delivery) for ${order_id}`,
    });

    // 2) USER 50% PLATFORM FEE: USER → ADMIN
    let tUserFee = null;
    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        order_id,
        note: `Platform fee (user 50%) for ${order_id}`,
      });
    }

    // 3) MERCHANT 50% PLATFORM FEE: MERCHANT → ADMIN
    let tMerchFee = null;
    if (merchFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merch.wallet_id,
        toId: admin.wallet_id,
        amount: merchFee,
        order_id,
        note: `Platform fee (merchant 50%) for ${order_id}`,
      });
    }

    await conn.query(
      `INSERT INTO order_wallet_captures
         (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
       VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
      [
        order_id,
        tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
        tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
        tOrder ? `${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null,
      ]
    );

    await conn.commit();

    return {
      captured: true,
      user_id: order.user_id,
      order_amount: baseToMerchant,
      platform_fee_user: userFee,
      platform_fee_merchant: merchFee,
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

/**
 * COD orders:
 * - Customer pays cash for items+delivery.
 * - User wallet: 50% platform fee → Admin.
 * - Merchant wallet: 50% platform fee → Admin.
 * - merchant_delivery_fee is separate (used later).
 */
async function captureOrderCODFee(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (await captureExists(order_id, "COD_FEE", conn)) {
      await conn.commit();
      return { captured: false, alreadyCaptured: true };
    }

    const [[order]] = await conn.query(
      `SELECT user_id, platform_fee, payment_method
         FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!order) throw new Error("Order not found for COD fee capture");
    if (String(order.payment_method || "").toUpperCase() !== "COD") {
      await conn.commit();
      return {
        captured: false,
        skipped: true,
        reason: "payment_method != COD",
      };
    }

    const split = await computeBusinessSplit(order_id, conn);
    const feeForPrimary = Number(split.platform_fee || 0);

    const userFee = feeForPrimary * PLATFORM_USER_SHARE;
    const merchantFee = feeForPrimary - userFee;

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
    const admin = await getAdminWallet(conn);
    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merch) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    if (feeForPrimary > 0) {
      const [[freshBuyer]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [buyer.id]
      );
      if (!freshBuyer || Number(freshBuyer.amount) < userFee) {
        throw new Error(
          "Insufficient user wallet balance for COD platform fee share."
        );
      }

      const [[freshMerchant]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [merch.id]
      );
      if (!freshMerchant || Number(freshMerchant.amount) < merchantFee) {
        throw new Error(
          "Insufficient merchant wallet balance for COD platform fee share."
        );
      }

      let tUserFee = null;
      let tMerchFee = null;

      if (userFee > 0) {
        tUserFee = await recordWalletTransfer(conn, {
          fromId: buyer.wallet_id,
          toId: admin.wallet_id,
          amount: userFee,
          order_id,
          note: `COD platform fee (user 50%) for ${order_id}`,
        });
      }

      if (merchantFee > 0) {
        tMerchFee = await recordWalletTransfer(conn, {
          fromId: merch.wallet_id,
          toId: admin.wallet_id,
          amount: merchantFee,
          order_id,
          note: `COD platform fee (merchant 50%) for ${order_id}`,
        });
      }

      const adminTxnSummary = [
        tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : "",
        tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : "",
      ]
        .filter(Boolean)
        .join(";");

      await conn.query(
        `INSERT INTO order_wallet_captures (order_id, capture_type, admin_txn_id)
         VALUES (?, 'COD_FEE', ?)`,
        [order_id, adminTxnSummary || null]
      );
    } else {
      await conn.query(
        `INSERT INTO order_wallet_captures (order_id, capture_type, admin_txn_id)
         VALUES (?, 'COD_FEE', NULL)`,
        [order_id]
      );
    }

    await conn.commit();

    return {
      captured: true,
      user_id: order.user_id,
      order_amount: 0,
      platform_fee_user: userFee, // user share only for notification
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

/* ================= APPLY UNAVAILABLE ITEM CHANGES ================= */
async function applyUnavailableItemChanges(order_id, changes) {
  const removed = Array.isArray(changes?.removed) ? changes.removed : [];
  const replaced = Array.isArray(changes?.replaced) ? changes.replaced : [];
  if (!removed.length && !replaced.length) return;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    for (const r of removed) {
      const bid = Number(r.business_id);
      const mid = Number(r.menu_id);
      if (!bid || !mid) continue;

      await conn.query(
        `DELETE FROM order_items
          WHERE order_id = ? AND business_id = ? AND menu_id = ?
          LIMIT 1`,
        [order_id, bid, mid]
      );
    }

    for (const ch of replaced) {
      const old = ch.old || {};
      const neu = ch.new || {};
      const bidOld = Number(old.business_id);
      const midOld = Number(old.menu_id);
      if (!bidOld || !midOld) continue;

      const [rows] = await conn.query(
        `SELECT * FROM order_items
          WHERE order_id = ? AND business_id = ? AND menu_id = ?
          LIMIT 1`,
        [order_id, bidOld, midOld]
      );
      if (!rows.length) continue;

      const row = rows[0];

      const bidNew =
        neu.business_id != null ? Number(neu.business_id) : row.business_id;
      const bnameNew = neu.business_name || row.business_name;
      const menuNew = neu.menu_id != null ? Number(neu.menu_id) : row.menu_id;
      const itemName = neu.item_name || row.item_name;
      const image =
        neu.item_image !== undefined ? neu.item_image : row.item_image;
      const qty = neu.quantity != null ? Number(neu.quantity) : row.quantity;
      const price = neu.price != null ? Number(neu.price) : row.price;
      const subtotal =
        neu.subtotal != null ? Number(neu.subtotal) : row.subtotal;

      await conn.query(
        `UPDATE order_items
            SET business_id = ?,
                business_name = ?,
                menu_id = ?,
                item_name = ?,
                item_image = ?,
                quantity = ?,
                price = ?,
                subtotal = ?
          WHERE item_id = ?`,
        [
          bidNew,
          bnameNew,
          menuNew,
          itemName,
          image,
          qty,
          price,
          subtotal,
          row.item_id,
        ]
      );
    }

    await conn.commit();
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

/* ================= PUBLIC MODEL API ================= */
const Order = {
  getBuyerWalletByUserId,
  getAdminWallet,

  captureOrderFunds,
  captureOrderCODFee,

  applyUnavailableItemChanges,

  peekNewOrderId: () => generateOrderId(),

  create: async (orderData) => {
    const order_id = generateOrderId();

    await db.query(`INSERT INTO orders SET ?`, {
      order_id,
      user_id: orderData.user_id,
      total_amount:
        orderData.total_amount != null ? Number(orderData.total_amount) : 0,
      discount_amount:
        orderData.discount_amount != null
          ? Number(orderData.discount_amount)
          : 0,
      delivery_fee:
        orderData.delivery_fee != null ? Number(orderData.delivery_fee) : 0,
      platform_fee:
        orderData.platform_fee != null ? Number(orderData.platform_fee) : 0,
      merchant_delivery_fee:
        orderData.merchant_delivery_fee != null
          ? Number(orderData.merchant_delivery_fee)
          : null,
      payment_method: orderData.payment_method,
      delivery_address:
        orderData.delivery_address &&
        typeof orderData.delivery_address === "object"
          ? JSON.stringify(orderData.delivery_address)
          : orderData.delivery_address,
      note_for_restaurant: orderData.note_for_restaurant || null,
      if_unavailable:
        orderData.if_unavailable !== undefined &&
        orderData.if_unavailable !== null
          ? String(orderData.if_unavailable)
          : null,
      status: (orderData.status || "PENDING").toUpperCase(),
      fulfillment_type: orderData.fulfillment_type || "Delivery",
      priority: !!orderData.priority,
    });

    for (const item of orderData.items || []) {
      await db.query(`INSERT INTO order_items SET ?`, {
        order_id,
        business_id: item.business_id,
        business_name: item.business_name,
        menu_id: item.menu_id,
        item_name: item.item_name,
        item_image: item.item_image || null,
        quantity: item.quantity,
        price: item.price,
        subtotal: item.subtotal,
        platform_fee: 0, // per-item stays 0
        delivery_fee: 0, // per-item stays 0
      });
    }
    return order_id;
  },

  findAll: async () => {
    await ensureStatusReasonSupport();
    const [orders] = await db.query(
      `SELECT o.* FROM orders o ORDER BY o.created_at DESC`
    );
    if (!orders.length) return [];

    const ids = orders.map((o) => o.order_id);
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id IN (?) ORDER BY order_id, business_id, menu_id`,
      [ids]
    );

    const byOrder = new Map();
    for (const o of orders) {
      o.items = [];
      o.delivery_address = parseDeliveryAddress(o.delivery_address);
      byOrder.set(o.order_id, o);
    }

    for (const it of items) byOrder.get(it.order_id)?.items.push(it);
    return orders;
  },

  findById: async (order_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.delivery_fee,
        o.platform_fee,
        o.merchant_delivery_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.if_unavailable,
        o.estimated_arrivial_time,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      WHERE o.order_id = ?
      `,
      [order_id]
    );
    if (!orders.length) return null;

    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id, business_id, menu_id`,
      [order_id]
    );
    orders[0].items = items;
    orders[0].delivery_address = parseDeliveryAddress(
      orders[0].delivery_address
    );
    orders[0].if_unavailable = orders[0].if_unavailable || null;
    return orders[0];
  },

  findByBusinessId: async (business_id) => {
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE business_id = ? ORDER BY order_id DESC, menu_id ASC`,
      [business_id]
    );
    return items;
  },

  findByBusinessGroupedByUser: async (business_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT DISTINCT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.delivery_fee,
        o.platform_fee,
        o.merchant_delivery_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.if_unavailable,
        o.estimated_arrivial_time,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.order_id AND oi.business_id = ?
      LEFT  JOIN users u ON u.user_id = o.user_id
      ORDER BY o.created_at DESC
      `,
      [business_id]
    );

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.order_id);

    // IMPORTANT CHANGE:
    // Do NOT fetch per-item delivery_fee and platform_fee here.
    const [items] = await db.query(
      `
      SELECT 
        item_id,
        order_id,
        business_id,
        business_name,
        menu_id,
        item_name,
        item_image,
        quantity,
        price,
        subtotal
      FROM order_items
      WHERE business_id = ? AND order_id IN (?)
      ORDER BY order_id, business_id, menu_id
      `,
      [business_id, orderIds]
    );

    const itemsByOrder = new Map();
    for (const it of items) {
      if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
      itemsByOrder.get(it.order_id).push(it);
    }

    const grouped = new Map();
    for (const o of orders) {
      const its = itemsByOrder.get(o.order_id) || [];

      const shareSubtotal = its.reduce(
        (s, it) => s + Number(it.subtotal || 0),
        0
      );

      const baseTotal =
        its.length > 0
          ? Number(o.total_amount || 0) - Number(o.platform_fee || 0)
          : 0;

      // business fee share proportional by subtotal
      const fee_share =
        baseTotal > 0 && shareSubtotal > 0
          ? Number(o.platform_fee || 0) * (shareSubtotal / baseTotal)
          : 0;

      const net_for_business = shareSubtotal - fee_share;

      if (!grouped.has(o.user_id)) {
        grouped.set(o.user_id, {
          user: {
            user_id: o.user_id,
            name: o.user_name || null,
            email: o.user_email || null,
            phone: o.user_phone || null,
          },
          orders: [],
        });
      }
      grouped.get(o.user_id).orders.push({
        order_id: o.order_id,
        status: o.status,
        status_reason: o.status_reason || null,
        total_amount: o.total_amount,
        discount_amount: o.discount_amount,
        delivery_fee: o.delivery_fee,
        platform_fee: o.platform_fee,
        merchant_delivery_fee: o.merchant_delivery_fee,
        payment_method: o.payment_method,
        delivery_address: parseDeliveryAddress(o.delivery_address),
        note_for_restaurant: o.note_for_restaurant,
        if_unavailable: o.if_unavailable || null,
        estimated_arrivial_time: o.estimated_arrivial_time || null,
        fulfillment_type: o.fulfillment_type,
        priority: o.priority,
        created_at: o.created_at,
        updated_at: o.updated_at,
        items: its, // these items no longer have delivery_fee / platform_fee fields
        totals_for_business: {
          business_share: Number(shareSubtotal.toFixed(2)),
          fee_share: Number(fee_share.toFixed(2)),
          net_for_business: Number(net_for_business.toFixed(2)),
        },
      });
    }

    return Array.from(grouped.values());
  },

  findByOrderIdGrouped: async (order_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.delivery_fee,
        o.platform_fee,
        o.merchant_delivery_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.if_unavailable,
        o.estimated_arrivial_time,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      LEFT JOIN users u ON u.user_id = o.user_id
      WHERE o.order_id = ?
      LIMIT 1
      `,
      [order_id]
    );
    if (!orders.length) return [];

    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id, business_id, menu_id`,
      [order_id]
    );

    const o = orders[0];
    o.items = items;

    return [
      {
        user: {
          user_id: o.user_id,
          name: o.user_name || null,
          email: o.user_email || null,
          phone: o.user_phone || null,
        },
        orders: [
          {
            order_id: o.order_id,
            status: o.status,
            status_reason: o.status_reason || null,
            total_amount: o.total_amount,
            discount_amount: o.discount_amount,
            delivery_fee: o.delivery_fee,
            platform_fee: o.platform_fee,
            merchant_delivery_fee: o.merchant_delivery_fee,
            payment_method: o.payment_method,
            delivery_address: parseDeliveryAddress(o.delivery_address),
            note_for_restaurant: o.note_for_restaurant,
            if_unavailable: o.if_unavailable || null,
            estimated_arrivial_time: o.estimated_arrivial_time || null,
            fulfillment_type: o.fulfillment_type,
            priority: o.priority,
            created_at: o.created_at,
            updated_at: o.updated_at,
            items: o.items,
          },
        ],
      },
    ];
  },

  findByUserIdForApp: async (user_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.delivery_fee,
        o.platform_fee,
        o.merchant_delivery_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.if_unavailable,
        o.estimated_arrivial_time,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
      `,
      [user_id]
    );
    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.order_id);
    const [items] = await db.query(
      `
      SELECT order_id,business_id,business_name,menu_id,item_name,item_image,quantity,price,subtotal,platform_fee,delivery_fee
      FROM order_items
      WHERE order_id IN (?)
      ORDER BY order_id, business_id, menu_id
      `,
      [orderIds]
    );

    const itemsByOrder = new Map();
    for (const it of items) {
      if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
      itemsByOrder.get(it.order_id).push(it);
    }

    const result = [];
    for (const o of orders) {
      const its = itemsByOrder.get(o.order_id) || [];
      const primaryBiz = its[0] || null;

      result.push({
        order_id: o.order_id,
        status: o.status,
        status_reason: o.status_reason || null,
        payment_method: o.payment_method,
        fulfillment_type: o.fulfillment_type,
        created_at: o.created_at,
        if_unavailable: o.if_unavailable || null,
        estimated_arrivial_time: o.estimated_arrivial_time || null,
        restaurant: primaryBiz
          ? {
              business_id: primaryBiz.business_id,
              name: primaryBiz.business_name,
            }
          : null,
        deliver_to: parseDeliveryAddress(o.delivery_address),
        totals: {
          items_subtotal: its.reduce(
            (s, it) => s + Number(it.subtotal || 0),
            0
          ),
          delivery_fee: Number(o.delivery_fee || 0), // order-level user delivery fee
          merchant_delivery_fee:
            o.merchant_delivery_fee !== null
              ? Number(o.merchant_delivery_fee)
              : null, // merchant-side delivery fee (for free-delivery scenario)
          platform_fee: Number(o.platform_fee || 0),
          discount_amount: Number(o.discount_amount || 0),
          total_amount: Number(o.total_amount || 0),
        },
        items: its.map((it) => ({
          menu_id: it.menu_id,
          name: it.item_name,
          image: it.item_image,
          quantity: it.quantity,
          unit_price: it.price,
          line_subtotal: it.subtotal,
        })),
      });
    }

    return result;
  },

  update: async (order_id, orderData) => {
    if (!orderData || !Object.keys(orderData).length) return 0;
    if (orderData.status)
      orderData.status = String(orderData.status).toUpperCase();

    if (Object.prototype.hasOwnProperty.call(orderData, "delivery_address")) {
      if (
        orderData.delivery_address &&
        typeof orderData.delivery_address === "object"
      ) {
        orderData.delivery_address = JSON.stringify(orderData.delivery_address);
      } else if (orderData.delivery_address == null) {
        orderData.delivery_address = null;
      } else {
        orderData.delivery_address = String(orderData.delivery_address);
      }
    }

    const fields = Object.keys(orderData);
    const values = Object.values(orderData);
    const setClause = fields.map((f) => `\`${f}\` = ?`).join(", ");

    const [result] = await db.query(
      `UPDATE orders SET ${setClause}, updated_at = NOW() WHERE order_id = ?`,
      [...values, order_id]
    );
    return result.affectedRows;
  },

  updateStatus: async (order_id, status, reason) => {
    const hasReason = await ensureStatusReasonSupport();
    if (hasReason) {
      const [r] = await db.query(
        `UPDATE orders SET status = ?, status_reason = ?, updated_at = NOW() WHERE order_id = ?`,
        [String(status).toUpperCase(), String(reason || "").trim(), order_id]
      );
      return r.affectedRows;
    } else {
      const [r] = await db.query(
        `UPDATE orders SET status = ?, updated_at = NOW() WHERE order_id = ?`,
        [String(status).toUpperCase(), order_id]
      );
      return r.affectedRows;
    }
  },

  delete: async (order_id) => {
    const [r] = await db.query(`DELETE FROM orders WHERE order_id = ?`, [
      order_id,
    ]);
    return r.affectedRows;
  },

  addUserOrderStatusNotification: async ({
    user_id,
    order_id,
    status,
    reason = "",
    conn = null,
  }) => {
    await addUserOrderStatusNotificationInternal(
      user_id,
      order_id,
      status,
      reason,
      conn
    );
  },

  addUserUnavailableItemNotification: async ({
    user_id,
    order_id,
    changes,
    final_total_amount = null,
    conn = null,
  }) => {
    await addUserUnavailableItemNotificationInternal(
      user_id,
      order_id,
      changes,
      final_total_amount,
      conn
    );
  },

  addUserWalletDebitNotification: async ({
    user_id,
    order_id,
    order_amount,
    platform_fee,
    method,
    conn = null,
  }) => {
    await addUserWalletDebitNotificationInternal(
      user_id,
      order_id,
      order_amount,
      platform_fee,
      method,
      conn
    );
  },

  // points awarding API used by controller
  awardPointsForCompletedOrder,
};

/* ====================== KPI COUNTS BY BUSINESS ====================== */
Order.getOrderStatusCountsByBusiness = async (business_id) => {
  const [rows] = await db.query(
    `
    SELECT o.status, COUNT(DISTINCT o.order_id) AS count
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.order_id
     WHERE oi.business_id = ?
     GROUP BY o.status
    `,
    [business_id]
  );

  const allStatuses = [
    "PENDING",
    "CONFIRMED",
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "COMPLETED",
    "CANCELLED",
    "REJECTED",
    "DECLINED",
  ];

  const result = {};
  for (const s of allStatuses) result[s] = 0;

  for (const row of rows) {
    const key = String(row.status || "").toUpperCase();
    if (key) result[key] = Number(row.count) || 0;
  }

  const [todayRows] = await db.query(
    `
    SELECT COUNT(DISTINCT o.order_id) AS declined_today
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.order_id
     WHERE oi.business_id = ?
       AND o.status = 'DECLINED'
       AND DATE(o.created_at) = CURDATE()
    `,
    [business_id]
  );

  result.order_declined_today = Number(todayRows[0]?.declined_today || 0);

  return result;
};

module.exports = Order;
