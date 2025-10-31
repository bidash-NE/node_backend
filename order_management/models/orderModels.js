// models/orderModels.js
const db = require("../config/db");
const axios = require("axios");

/* ======================= CONFIG ======================= */
const ADMIN_WALLET_ID = "NET000001"; // admin wallet

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
  const n = Math.floor(10000000 + Math.random() * 90000000); // 8 digits
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

  // Fallback: single endpoints
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
    `SELECT order_id,total_amount,platform_fee FROM orders WHERE order_id = ? LIMIT 1`,
    [order_id]
  );
  if (!order) throw new Error("Order not found while computing split");

  const [items] = await dbh.query(
    `SELECT business_id, subtotal, delivery_fee
       FROM order_items
      WHERE order_id = ?
      ORDER BY menu_id ASC`,
    [order_id]
  );
  if (!items.length) throw new Error("Order has no items");

  const byBiz = new Map();
  for (const it of items) {
    const part = Number(it.subtotal || 0) + Number(it.delivery_fee || 0);
    byBiz.set(it.business_id, (byBiz.get(it.business_id) || 0) + part);
  }

  const total = Number(order.total_amount || 0);
  const fee = Number(order.platform_fee || 0);
  const primaryBizId = items[0].business_id;

  if (byBiz.size === 1) {
    return {
      business_id: primaryBizId,
      total_amount: total,
      platform_fee: fee,
      net_to_merchant: total - fee,
    };
  }

  const primaryShare = byBiz.get(primaryBizId) || 0;
  const feeShare = total > 0 ? fee * (primaryShare / total) : 0;

  return {
    business_id: primaryBizId,
    total_amount: primaryShare,
    platform_fee: feeShare,
    net_to_merchant: primaryShare - feeShare,
  };
}

/**
 * Record a wallet transfer as TWO rows in wallet_transactions:
 *  - DR: debit from fromId
 *  - CR: credit to toId
 * remark is 'DR'/'CR'; descriptive text goes to note.
 * Also updates wallet balances atomically.
 */
async function recordWalletTransfer(
  conn,
  { fromId, toId, amount, order_id, note = null }
) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return null;

  // Atomic balance update
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

  // IDs
  const { dr_id, cr_id, journal_id } = await fetchTxnAndJournalIds();

  // DR row
  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
    [dr_id, journal_id || null, fromId, toId, amt, note]
  );

  // CR row
  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
    [cr_id, journal_id || null, fromId, toId, amt, note]
  );

  return { dr_txn_id: dr_id, cr_txn_id: cr_id, journal_id };
}

/* ================= PUBLIC CAPTURE APIS ================= */
/** WALLET path: charge user → merchant (net) and user → admin (platform fee). Add notifications. */
async function captureOrderFunds(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (await captureExists(order_id, "WALLET_FULL", conn)) {
      await conn.commit();
      return { alreadyCaptured: true };
    }

    const [[order]] = await conn.query(
      `SELECT user_id, total_amount, platform_fee, payment_method
         FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!order) throw new Error("Order not found for capture");
    if (String(order.payment_method || "WALLET").toUpperCase() !== "WALLET") {
      await conn.commit();
      return { skipped: true, reason: "payment_method != WALLET" };
    }

    const split = await computeBusinessSplit(order_id, conn);
    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merch) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const total = Number(order.total_amount || 0);
    const fee = Number(split.platform_fee || 0);
    const toMerch = Number(split.net_to_merchant || 0);

    // Ensure buyer has enough for TOTAL (net+fee)
    const [[freshBuyer]] = await conn.query(
      `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
      [buyer.id]
    );
    if (!freshBuyer || Number(freshBuyer.amount) < total) {
      throw new Error("Insufficient wallet balance during capture");
    }

    // USER → MERCHANT (net)
    const t1 = await recordWalletTransfer(conn, {
      fromId: buyer.wallet_id,
      toId: merch.wallet_id,
      amount: toMerch,
      order_id,
      note: `Wallet capture (USER→MERCHANT) for ${order_id}`,
    });

    // Merchant notification (credit)
    const bodyCR = `CR ${t1?.cr_txn_id || "-"} · JRN ${t1?.journal_id || "-"}`;
    await conn.query(
      `INSERT INTO order_notification
         (notification_id, order_id, business_id, user_id, type, title, body_preview, is_read, created_at)
       VALUES (UUID(), ?, ?, ?, 'order:wallet_txn', 'Amount credited', ?, 0, NOW())`,
      [order_id, split.business_id, order.user_id, bodyCR]
    );

    // User debit notification (USER→MERCHANT)
    await insertUserNotification(conn, {
      user_id: order.user_id,
      title: "Transaction successful",
      message: `Your account has been debited with Nu. ${fmtNu(
        toMerch
      )} from acc ${buyer.wallet_id} to ${merch.wallet_id}.`,
      type: "wallet_debit",
      data: {
        order_id,
        from: buyer.wallet_id,
        to: merch.wallet_id,
        amount: toMerch,
      },
      status: "unread",
    });

    // USER → ADMIN (platform fee)
    if (fee > 0) {
      const t2 = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: fee,
        order_id,
        note: `Platform fee for ${order_id}`,
      });

      await insertUserNotification(conn, {
        user_id: order.user_id,
        title: "Transaction successful",
        message: `Your account has been debited with Nu. ${fmtNu(
          fee
        )} from acc ${buyer.wallet_id} to ${admin.wallet_id}.`,
        type: "wallet_debit",
        data: {
          order_id,
          from: buyer.wallet_id,
          to: admin.wallet_id,
          amount: fee,
        },
        status: "unread",
      });

      await conn.query(
        `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
         VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
        [
          order_id,
          `${t1?.dr_txn_id || ""}/${t1?.cr_txn_id || ""}`,
          `${t1?.dr_txn_id || ""}/${t1?.cr_txn_id || ""}`,
          `${t2?.dr_txn_id || ""}/${t2?.cr_txn_id || ""}`,
        ]
      );
    } else {
      await conn.query(
        `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
         VALUES (?, 'WALLET_FULL', ?, ?, NULL)`,
        [
          order_id,
          `${t1?.dr_txn_id || ""}/${t1?.cr_txn_id || ""}`,
          `${t1?.dr_txn_id || ""}/${t1?.cr_txn_id || ""}`,
        ]
      );
    }

    await conn.commit();
    return { captured: true };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

/** COD path: charge user → admin (platform fee only). User gets debit notification only. */
async function captureOrderCODFee(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (await captureExists(order_id, "COD_FEE", conn)) {
      await conn.commit();
      return { alreadyCaptured: true };
    }

    const [[order]] = await conn.query(
      `SELECT user_id, platform_fee, payment_method
         FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!order) throw new Error("Order not found for COD fee capture");
    if (String(order.payment_method || "").toUpperCase() !== "COD") {
      await conn.commit();
      return { skipped: true, reason: "payment_method != COD" };
    }

    const fee = Number(order.platform_fee || 0);
    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const admin = await getAdminWallet(conn);
    if (!buyer) throw new Error("Buyer wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    if (fee > 0) {
      const [[freshBuyer]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [buyer.id]
      );
      if (!freshBuyer || Number(freshBuyer.amount) < fee) {
        throw new Error(
          "Insufficient user wallet balance for COD platform fee."
        );
      }

      const t = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: fee,
        order_id,
        note: `Platform fee for ${order_id}`,
      });

      // User debit notification
      await insertUserNotification(conn, {
        user_id: order.user_id,
        title: "Transaction successful",
        message: `Your account has been debited with Nu. ${fmtNu(
          fee
        )} from acc ${buyer.wallet_id} to ${admin.wallet_id}.`,
        type: "wallet_debit",
        data: {
          order_id,
          from: buyer.wallet_id,
          to: admin.wallet_id,
          amount: fee,
        },
        status: "unread",
      });

      await conn.query(
        `INSERT INTO order_wallet_captures (order_id, capture_type, admin_txn_id)
         VALUES (?, 'COD_FEE', ?)`,
        [order_id, `${t.dr_txn_id}/${t.cr_txn_id}`]
      );
    } else {
      await conn.query(
        `INSERT INTO order_wallet_captures (order_id, capture_type, admin_txn_id)
         VALUES (?, 'COD_FEE', NULL)`,
        [order_id]
      );
    }

    await conn.commit();
    return { captured: true };
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
  // expose wallet lookups if controller needs them
  getBuyerWalletByUserId,
  getAdminWallet,

  // capture apis
  captureOrderFunds,
  captureOrderCODFee,

  // write paths
  peekNewOrderId: () => generateOrderId(),

  create: async (orderData) => {
    const order_id = generateOrderId();

    await db.query(`INSERT INTO orders SET ?`, {
      order_id,
      user_id: orderData.user_id,
      total_amount: orderData.total_amount,
      discount_amount: orderData.discount_amount,
      platform_fee: orderData.platform_fee ?? 0,
      payment_method: orderData.payment_method,
      delivery_address: orderData.delivery_address,
      note_for_restaurant: orderData.note_for_restaurant || null,
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
        delivery_fee: item.delivery_fee ?? 0,
      });
    }
    return order_id;
  },

  /* reads */
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
        o.platform_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
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
        o.platform_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
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
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE business_id = ? AND order_id IN (?) ORDER BY order_id, business_id, menu_id`,
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

      // compute merchant-side totals (after platform fee)
      const share = its.reduce(
        (s, it) => s + Number(it.subtotal || 0) + Number(it.delivery_fee || 0),
        0
      );
      const fee_share =
        Number(o.total_amount || 0) > 0
          ? Number(o.platform_fee || 0) * (share / Number(o.total_amount || 0))
          : 0;
      const net_for_business = share - fee_share;

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
        platform_fee: o.platform_fee,
        payment_method: o.payment_method,
        delivery_address: o.delivery_address,
        note_for_restaurant: o.note_for_restaurant,
        fulfillment_type: o.fulfillment_type,
        priority: o.priority,
        created_at: o.created_at,
        updated_at: o.updated_at,
        items: its,
        totals_for_business: {
          business_share: Number(share.toFixed(2)),
          fee_share: Number(fee_share.toFixed(2)),
          net_for_business: Number(net_for_business.toFixed(2)), // display this to merchant
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
        o.platform_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
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
            platform_fee: o.platform_fee,
            payment_method: o.payment_method,
            delivery_address: o.delivery_address,
            note_for_restaurant: o.note_for_restaurant,
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
        o.platform_fee,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
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
        restaurant: primaryBiz
          ? {
              business_id: primaryBiz.business_id,
              name: primaryBiz.business_name,
            }
          : null,
        deliver_to: o.delivery_address,
        totals: {
          items_subtotal: null,
          platform_fee: Number(o.platform_fee || 0),
          delivery_fee: 0,
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
          line_delivery_fee: it.delivery_fee,
        })),
      });
    }

    return result;
  },

  update: async (order_id, orderData) => {
    if (!orderData || !Object.keys(orderData).length) return 0;
    if (orderData.status)
      orderData.status = String(orderData.status).toUpperCase();

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

  // Default all possible statuses = 0
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

  // 🔹 Count orders declined today only
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
