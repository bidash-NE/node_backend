// models/orderModels.js
const db = require("../config/db");
const axios = require("axios");

/* ======================= CONFIG ======================= */
const ADMIN_WALLET_ID = "NET000001";
const PLATFORM_USER_SHARE = 0.5;
const PLATFORM_MERCHANT_SHARE = 0.5;

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

let _hasServiceType = null;
async function ensureServiceTypeSupport() {
  if (_hasServiceType !== null) return _hasServiceType;
  const [rows] = await db.query(`
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'service_type'
  `);
  _hasServiceType = rows.length > 0;
  return _hasServiceType;
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
  const feeAmt = Number(platform_fee || 0);

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

async function awardPointsForCompletedOrder(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

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

    const already = await hasPointsAwardNotification(order_id, conn);
    if (already) {
      await conn.rollback();
      return { awarded: false, reason: "already_awarded" };
    }

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

    const units = Math.floor(totalAmount / minAmount);
    const points = units * perPoint;

    if (points <= 0) {
      await conn.rollback();
      return { awarded: false, reason: "computed_zero" };
    }

    await conn.query(`UPDATE users SET points = points + ? WHERE user_id = ?`, [
      points,
      order.user_id,
    ]);

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

  const primaryDelivery =
    subtotalTotal > 0
      ? deliveryTotal * (primarySub / subtotalTotal)
      : deliveryTotal;

  const baseTotal = subtotalTotal + deliveryTotal;
  const primaryBase = primarySub + primaryDelivery;

  if (byBiz.size === 1) {
    return {
      business_id: primaryBizId,
      total_amount: Number(primaryBase.toFixed(2)),
      platform_fee: feeTotal,
      net_to_merchant: Number((primaryBase - feeTotal).toFixed(2)),
    };
  }

  const primaryFeeShare =
    baseTotal > 0 ? feeTotal * (primaryBase / baseTotal) : 0;

  return {
    business_id: primaryBizId,
    total_amount: Number(primaryBase.toFixed(2)),
    platform_fee: Number(primaryFeeShare.toFixed(2)),
    net_to_merchant: Number((primaryBase - primaryFeeShare).toFixed(2)),
  };
}

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

    const baseToMerchant = Number(split.total_amount || 0);
    const feeForPrimary = Number(split.platform_fee || 0);

    const userFee =
      feeForPrimary > 0 ? Number((feeForPrimary / 2).toFixed(2)) : 0;
    const merchFee = feeForPrimary - userFee;

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

    const tOrder = await recordWalletTransfer(conn, {
      fromId: buyer.wallet_id,
      toId: merch.wallet_id,
      amount: baseToMerchant,
      order_id,
      note: `Order base (items+delivery) for ${order_id}`,
    });

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
      platform_fee_user: userFee,
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

/* ================= CANCELLED ARCHIVE HELPERS ================= */
async function tableExists(table, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT 1
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
     LIMIT 1
    `,
    [table]
  );
  return rows.length > 0;
}

async function getTableColumns(table, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
    `,
    [table]
  );
  return new Set(rows.map((r) => String(r.COLUMN_NAME)));
}

function pick(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

async function archiveCancelledOrderInternal(
  conn,
  order_id,
  { cancelled_by = "SYSTEM", reason = "" } = {}
) {
  const hasCancelledOrders = await tableExists("cancelled_orders", conn);
  const hasCancelledItems = await tableExists("cancelled_order_items", conn);
  if (!hasCancelledOrders && !hasCancelledItems) return { archived: false };

  const [[order]] = await conn.query(
    `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
    [order_id]
  );
  if (!order) return { archived: false };

  const [items] = await conn.query(
    `SELECT * FROM order_items WHERE order_id = ?`,
    [order_id]
  );

  if (hasCancelledOrders) {
    const cols = await getTableColumns("cancelled_orders", conn);

    const row = {};
    if (cols.has("order_id")) row.order_id = order.order_id;
    if (cols.has("user_id")) row.user_id = order.user_id;
    if (cols.has("service_type")) row.service_type = order.service_type || null;
    if (cols.has("payment_method")) row.payment_method = order.payment_method;
    if (cols.has("total_amount")) row.total_amount = order.total_amount;
    if (cols.has("discount_amount"))
      row.discount_amount = order.discount_amount;
    if (cols.has("delivery_fee")) row.delivery_fee = order.delivery_fee;
    if (cols.has("merchant_delivery_fee"))
      row.merchant_delivery_fee = order.merchant_delivery_fee;
    if (cols.has("platform_fee")) row.platform_fee = order.platform_fee;
    if (cols.has("delivery_address"))
      row.delivery_address = order.delivery_address;
    if (cols.has("note_for_restaurant"))
      row.note_for_restaurant = order.note_for_restaurant;
    if (cols.has("if_unavailable")) row.if_unavailable = order.if_unavailable;
    if (cols.has("status")) row.status = "CANCELLED";

    const r =
      String(reason || "").trim() ||
      String(order.status_reason || "").trim() ||
      "";

    if (cols.has("status_reason")) row.status_reason = r;
    if (cols.has("cancel_reason")) row.cancel_reason = r;
    if (cols.has("cancelled_reason")) row.cancelled_reason = r;
    if (cols.has("reason")) row.reason = r;

    if (cols.has("cancelled_by")) row.cancelled_by = cancelled_by;
    if (cols.has("cancelled_at")) row.cancelled_at = new Date();

    if (cols.has("created_at") && pick(row, "created_at") === undefined)
      row.created_at = new Date();
    if (cols.has("updated_at") && pick(row, "updated_at") === undefined)
      row.updated_at = new Date();

    if (Object.keys(row).length) {
      const fields = Object.keys(row);
      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((k) => row[k]);

      await conn.query(
        `INSERT IGNORE INTO cancelled_orders (${fields.join(
          ", "
        )}) VALUES (${placeholders})`,
        values
      );
    }
  }

  if (hasCancelledItems && items.length) {
    const cols = await getTableColumns("cancelled_order_items", conn);

    for (const it of items) {
      const row = {};
      if (cols.has("order_id")) row.order_id = it.order_id;
      if (cols.has("business_id")) row.business_id = it.business_id;
      if (cols.has("business_name")) row.business_name = it.business_name;
      if (cols.has("menu_id")) row.menu_id = it.menu_id;
      if (cols.has("item_name")) row.item_name = it.item_name;
      if (cols.has("item_image")) row.item_image = it.item_image;
      if (cols.has("quantity")) row.quantity = it.quantity;
      if (cols.has("price")) row.price = it.price;
      if (cols.has("subtotal")) row.subtotal = it.subtotal;

      if (cols.has("cancelled_by")) row.cancelled_by = cancelled_by;
      if (cols.has("reason")) row.reason = String(reason || "").trim() || null;
      if (cols.has("cancelled_at")) row.cancelled_at = new Date();

      if (cols.has("created_at") && pick(row, "created_at") === undefined)
        row.created_at = new Date();
      if (cols.has("updated_at") && pick(row, "updated_at") === undefined)
        row.updated_at = new Date();

      if (Object.keys(row).length) {
        const fields = Object.keys(row);
        const placeholders = fields.map(() => "?").join(", ");
        const values = fields.map((k) => row[k]);
        await conn.query(
          `INSERT IGNORE INTO cancelled_order_items (${fields.join(
            ", "
          )}) VALUES (${placeholders})`,
          values
        );
      }
    }
  }

  return { archived: true };
}

async function deleteOrderFromMainTablesInternal(conn, order_id) {
  await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [order_id]);
  await conn.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);
}

/**
 * ✅ FINAL: cancel + archive + delete (used by BOTH auto & user)
 */
async function cancelAndArchiveOrder(
  order_id,
  {
    cancelled_by = "SYSTEM",
    reason = "",
    cancel_reason = "",
    onlyIfStatus = null, // "PENDING" or null
    expectedUserId = null, // user cancel verify
  } = {}
) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT order_id, user_id, status FROM orders WHERE order_id = ? FOR UPDATE`,
      [order_id]
    );

    if (!row) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const user_id = Number(row.user_id);
    const current = String(row.status || "").toUpperCase();

    if (expectedUserId != null && Number(expectedUserId) !== user_id) {
      await conn.rollback();
      return { ok: false, code: "FORBIDDEN" };
    }

    if (onlyIfStatus && current !== String(onlyIfStatus).toUpperCase()) {
      await conn.rollback();
      return { ok: false, code: "SKIPPED", current_status: current };
    }

    // business ids BEFORE deletion
    const [bizRows] = await conn.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const business_ids = bizRows.map((x) => x.business_id);

    const finalReason = String(reason || cancel_reason || "").trim();

    // mark cancelled (so archive copies status_reason if present)
    const [rr] = await conn.query(
      `
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME='orders'
         AND COLUMN_NAME='status_reason'
       LIMIT 1
      `
    );
    const hasReason = rr.length > 0;

    if (hasReason) {
      await conn.query(
        `UPDATE orders
            SET status='CANCELLED',
                status_reason=?,
                updated_at=NOW()
          WHERE order_id=?`,
        [finalReason, order_id]
      );
    } else {
      await conn.query(
        `UPDATE orders
            SET status='CANCELLED',
                updated_at=NOW()
          WHERE order_id=?`,
        [order_id]
      );
    }

    // archive then delete
    await archiveCancelledOrderInternal(conn, order_id, {
      cancelled_by,
      reason: finalReason,
    });

    await deleteOrderFromMainTablesInternal(conn, order_id);

    await conn.commit();
    return { ok: true, user_id, business_ids, status: "CANCELLED" };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
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

/* ================= PUBLIC MODEL API ================= */
const Order = {
  // wallets
  getBuyerWalletByUserId,
  getAdminWallet,

  // capture
  captureOrderFunds,
  captureOrderCODFee,

  // changes
  applyUnavailableItemChanges,

  // cancellation (FINAL)
  cancelAndArchiveOrder,
  cancelIfStillPending,

  // optional direct archive (fixed signature)
  archiveCancelledOrder: async (order_id, opts = {}) => {
    const {
      cancelled_by = "SYSTEM",
      reason = "",
      cancel_reason = "",
    } = opts || {};
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const out = await archiveCancelledOrderInternal(conn, order_id, {
        cancelled_by,
        reason: String(reason || cancel_reason || "").trim(),
      });
      await conn.commit();
      return out;
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      throw e;
    } finally {
      conn.release();
    }
  },

  peekNewOrderId: () => generateOrderId(),

  create: async (orderData) => {
    const order_id = generateOrderId();

    const serviceType = String(orderData.service_type || "").toUpperCase();
    if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
      throw new Error("Invalid service_type (must be FOOD or MART)");
    }

    await db.query(`INSERT INTO orders SET ?`, {
      order_id,
      user_id: orderData.user_id,
      service_type: serviceType,

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
        platform_fee: 0,
        delivery_fee: 0,
      });
    }
    return order_id;
  },

  findAll: async () => {
    const hasReason = await ensureStatusReasonSupport();
    const hasService = await ensureServiceTypeSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.*,
        ${hasReason ? "o.status_reason" : "NULL AS status_reason"},
        ${hasService ? "o.service_type" : "NULL AS service_type"}
      FROM orders o
      ORDER BY o.created_at DESC
      `
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

  findByBusinessId: async (business_id) => {
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE business_id = ? ORDER BY order_id DESC, menu_id ASC`,
      [business_id]
    );
    return items;
  },

  findByOrderIdGrouped: async (order_id) => {
    const hasReason = await ensureStatusReasonSupport();
    const hasService = await ensureServiceTypeSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
        ${hasService ? "o.service_type," : "NULL AS service_type,"}
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
            service_type: o.service_type || null,
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

  findByUserIdForApp: async (user_id, service_type = null) => {
    const hasReason = await ensureStatusReasonSupport();
    const hasService = await ensureServiceTypeSupport();

    const params = [user_id];
    let serviceWhere = "";
    if (service_type && hasService) {
      serviceWhere = " AND o.service_type = ? ";
      params.push(service_type);
    }

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        ${hasService ? "o.service_type," : "NULL AS service_type,"}
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
      ${serviceWhere}
      ORDER BY o.created_at DESC
      `,
      params
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
        service_type: o.service_type || null,
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
          delivery_fee: Number(o.delivery_fee || 0),
          merchant_delivery_fee:
            o.merchant_delivery_fee !== null
              ? Number(o.merchant_delivery_fee)
              : null,
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

    if (Object.prototype.hasOwnProperty.call(orderData, "service_type")) {
      if (orderData.service_type != null) {
        const st = String(orderData.service_type || "").toUpperCase();
        if (!["FOOD", "MART"].includes(st)) {
          throw new Error("Invalid service_type (must be FOOD or MART)");
        }
        orderData.service_type = st;
      }
    }

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
