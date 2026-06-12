// orders/walletCaptureEngine.js
const db = require("../../config/db");
const {
  getBuyerWalletByUserId,
  getAdminWallet,
  getMerchantWalletByBusinessId,
} = require("./walletLookups");
const {
  fetchTxnAndJournalIds,
  prefetchTxnIdsBatch,
} = require("./walletIdService");

const PLATFORM_USER_SHARE = 0.5;
const PLATFORM_MERCHANT_SHARE = 0.5;

/* ================= CAPTURE HELPERS ================= */
async function captureExists(order_id, capture_type, conn = null) {
  const dbh = conn || db;
  const [[row]] = await dbh.query(
    `SELECT order_id
       FROM order_wallet_captures
      WHERE order_id = ? AND capture_type = ?
      LIMIT 1`,
    [order_id, capture_type],
  );
  return !!row;
}

async function computeBusinessSplit(order_id, conn = null) {
  const dbh = conn || db;

  const [[order]] = await dbh.query(
    `SELECT order_id, total_amount, platform_fee, delivery_fee, merchant_delivery_fee
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );
  if (!order) throw new Error("Order not found while computing split");

  const [items] = await dbh.query(
    `SELECT business_id, subtotal
       FROM order_items
      WHERE order_id = ?
      ORDER BY menu_id ASC`,
    [order_id],
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
  { fromId, toId, amount, note = null },
) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return null;

  const [dr] = await conn.query(
    `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
    [amt, fromId, amt],
  );
  if (!dr.affectedRows)
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);

  await conn.query(
    `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
    [amt, toId],
  );

  const { dr_id, cr_id, journal_id } = await fetchTxnAndJournalIds();

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
    [dr_id, journal_id || null, fromId, toId, amt, note],
  );

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
    [cr_id, journal_id || null, fromId, toId, amt, note],
  );

  return { dr_txn_id: dr_id, cr_txn_id: cr_id, journal_id: journal_id || null };
}

// Same as recordWalletTransfer but uses prefetched ids (NO HTTP inside DB tx)
async function recordWalletTransferWithIds(
  conn,
  { fromId, toId, amount, note = null, ids },
) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return null;

  const [dr] = await conn.query(
    `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
    [amt, fromId, amt],
  );
  if (!dr.affectedRows)
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);

  await conn.query(
    `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
    [amt, toId],
  );

  const { dr_id, cr_id, journal_id } = ids || {};
  if (!dr_id || !cr_id)
    throw new Error("Prefetched transaction ids missing (dr_id/cr_id).");

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
    [dr_id, journal_id || null, fromId, toId, amt, note],
  );

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
    [cr_id, journal_id || null, fromId, toId, amt, note],
  );

  return { dr_txn_id: dr_id, cr_txn_id: cr_id, journal_id: journal_id || null };
}

/* ================= PUBLIC CAPTURE APIS (standalone) ================= */
async function captureOrderFunds(order_id) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    if (await captureExists(order_id, "WALLET_FULL", conn)) {
      await conn.commit();
      return {
        captured: false,
        alreadyCaptured: true,
        payment_method: "WALLET",
        order_id,
      };
    }

    const [[order]] = await conn.query(
      `SELECT user_id, total_amount, platform_fee, merchant_delivery_fee, payment_method
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id],
    );

    if (!order) throw new Error("Order not found for capture");

    const pm = String(order.payment_method || "WALLET").toUpperCase();

    if (pm !== "WALLET") {
      await conn.commit();
      return {
        captured: false,
        skipped: true,
        payment_method: pm,
        reason: "payment_method != WALLET",
      };
    }

    // Still use this to identify the primary business/merchant wallet
    const split = await computeBusinessSplit(order_id, conn);

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merch) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const finalTotalAmount = Number(order.total_amount || 0);
    const platformFeeTotal = Number(order.platform_fee || 0);
    const merchantDeliveryFee = Number(order.merchant_delivery_fee || 0);

    if (!(finalTotalAmount > 0)) {
      throw new Error("Invalid total_amount for wallet capture");
    }

    const userFee =
      platformFeeTotal > 0
        ? Number((platformFeeTotal * PLATFORM_USER_SHARE).toFixed(2))
        : 0;

    const merchFee = Number((platformFeeTotal - userFee).toFixed(2));

    // Customer pays exactly the frontend-calculated payable total
    const needFromBuyer = finalTotalAmount;

    // Customer part going to merchant.
    // total_amount must already include only the user's platform-fee share.
    const buyerToMerchant = Number((finalTotalAmount - userFee).toFixed(2));

    if (buyerToMerchant < 0) {
      throw new Error("Invalid wallet split: buyerToMerchant is negative");
    }

    // Lock buyer wallet and verify customer has enough
    const [[freshBuyer]] = await conn.query(
      `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
      [buyer.id],
    );

    if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
      throw new Error("Insufficient wallet balance during capture");
    }

    // Lock admin wallet only if admin has to pay merchant delivery support
    if (merchantDeliveryFee > 0) {
      const [[freshAdmin]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [admin.id],
      );

      if (!freshAdmin || Number(freshAdmin.amount) < merchantDeliveryFee) {
        throw new Error(
          "Insufficient admin wallet balance for merchant delivery fee.",
        );
      }
    }

    // 1. Buyer pays merchant for order amount excluding user's platform fee
    const tOrder = await recordWalletTransfer(conn, {
      fromId: buyer.wallet_id,
      toId: merch.wallet_id,
      amount: buyerToMerchant,
      note: `Order amount from buyer to merchant for ${order_id}`,
    });

    // 2. Buyer pays user-side platform fee to admin
    let tUserFee = null;
    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        note: `Platform fee user share 50% for ${order_id}`,
      });
    }

    // 3. Admin pays merchant delivery support if delivery_fee is 0 but merchant_delivery_fee exists
    let tMerchantDelivery = null;
    if (merchantDeliveryFee > 0) {
      tMerchantDelivery = await recordWalletTransfer(conn, {
        fromId: admin.wallet_id,
        toId: merch.wallet_id,
        amount: merchantDeliveryFee,
        note: `Merchant delivery fee support for ${order_id}`,
      });
    }

    // 4. Merchant pays merchant-side platform fee to admin
    let tMerchFee = null;
    if (merchFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merch.wallet_id,
        toId: admin.wallet_id,
        amount: merchFee,
        note: `Platform fee merchant share 50% for ${order_id}`,
      });
    }

    const orderTxnRef = [
      tOrder ? `${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null,
      tMerchantDelivery
        ? `merchant_delivery:${tMerchantDelivery.dr_txn_id}/${tMerchantDelivery.cr_txn_id}`
        : null,
    ]
      .filter(Boolean)
      .join("|");

    await conn.query(
      `INSERT INTO order_wallet_captures
         (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
       VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
      [
        order_id,
        tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
        tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
        orderTxnRef || null,
      ],
    );

    await conn.commit();

    return {
      captured: true,
      payment_method: "WALLET",
      order_id,
      user_id: Number(order.user_id),
      business_id: Number(split.business_id),

      total_amount: finalTotalAmount,
      order_amount: buyerToMerchant,
      platform_fee_total: platformFeeTotal,
      platform_fee_user: userFee,
      platform_fee_merchant: merchFee,
      merchant_delivery_fee: merchantDeliveryFee,

      txns: {
        buyer_to_merchant: tOrder,
        buyer_platform_fee: tUserFee,
        admin_to_merchant_delivery: tMerchantDelivery,
        merchant_platform_fee: tMerchFee,
      },
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
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id],
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

    const userFee =
      feeForPrimary > 0
        ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
        : 0;
    const merchantFee = Number((feeForPrimary - userFee).toFixed(2));

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merch) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    if (userFee > 0) {
      const [[freshBuyer]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [buyer.id],
      );
      if (!freshBuyer || Number(freshBuyer.amount) < userFee) {
        throw new Error(
          "Insufficient user wallet balance for COD platform fee share.",
        );
      }
    }

    if (merchantFee > 0) {
      const [[freshMerchant]] = await conn.query(
        `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
        [merch.id],
      );
      if (!freshMerchant || Number(freshMerchant.amount) < merchantFee) {
        throw new Error(
          "Insufficient merchant wallet balance for COD platform fee share.",
        );
      }
    }

    let tUserFee = null;
    let tMerchFee = null;

    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        note: `COD platform fee (user 50%) for ${order_id}`,
      });
    }

    if (merchantFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merch.wallet_id,
        toId: admin.wallet_id,
        amount: merchantFee,
        note: `COD platform fee (merchant 50%) for ${order_id}`,
      });
    }

    await conn.query(
      `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
       VALUES (?, 'COD_FEE', ?, ?, ?)`,
      [
        order_id,
        tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
        tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
        tUserFee?.journal_id || tMerchFee?.journal_id || null,
      ],
    );

    await conn.commit();
    return {
      captured: true,
      payment_method: "COD",
      order_id,
      user_id: Number(order.user_id),
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

/* ================= Atomic CAPTURE inside existing transaction ================= */
async function captureOrderFundsWithConn(conn, order_id, prefetchedIds = []) {
  if (await captureExists(order_id, "WALLET_FULL", conn)) {
    return { captured: false, alreadyCaptured: true, payment_method: "WALLET" };
  }

  const [[order]] = await conn.query(
    `SELECT user_id, payment_method
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );
  if (!order) throw new Error("Order not found for capture");

  const pm = String(order.payment_method || "").toUpperCase();
  if (pm !== "WALLET")
    return { captured: false, skipped: true, payment_method: pm || "WALLET" };

  const split = await computeBusinessSplit(order_id, conn);
  const baseToMerchant = Number(split.total_amount || 0);
  const feeForPrimary = Number(split.platform_fee || 0);

  const userFee =
    feeForPrimary > 0
      ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
      : 0;
  const merchFee = Number((feeForPrimary - userFee).toFixed(2));
  const needFromBuyer = baseToMerchant + userFee;

  const buyer = await getBuyerWalletByUserId(order.user_id, conn);
  const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
  const admin = await getAdminWallet(conn);

  if (!buyer) throw new Error("Buyer wallet missing");
  if (!merch) throw new Error("Merchant wallet missing");
  if (!admin) throw new Error("Admin wallet missing");

  const [[freshBuyer]] = await conn.query(
    `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
    [buyer.id],
  );
  if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
    throw new Error("Insufficient wallet balance during capture");
  }

  if (merchFee > 0) {
    const [[freshMerch]] = await conn.query(
      `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
      [merch.id],
    );
    if (!freshMerch || Number(freshMerch.amount) < merchFee) {
      throw new Error(
        "Insufficient merchant wallet balance for platform fee share.",
      );
    }
  }

  // ids expected: 0=order, 1=user fee (optional), 2=merchant fee (optional)
  const ids0 = prefetchedIds?.[0];
  const ids1 = prefetchedIds?.[1];
  const ids2 = prefetchedIds?.[2];
  if (!ids0 || (userFee > 0 && !ids1) || (merchFee > 0 && !ids2)) {
    throw new Error(
      "Prefetched transaction ids are missing for WALLET capture",
    );
  }

  const tOrder = await recordWalletTransferWithIds(conn, {
    fromId: buyer.wallet_id,
    toId: merch.wallet_id,
    amount: baseToMerchant,
    note: `Order base (items+delivery) for ${order_id}`,
    ids: ids0,
  });

  let tUserFee = null;
  if (userFee > 0) {
    tUserFee = await recordWalletTransferWithIds(conn, {
      fromId: buyer.wallet_id,
      toId: admin.wallet_id,
      amount: userFee,
      note: `Platform fee (user 50%) for ${order_id}`,
      ids: ids1,
    });
  }

  let tMerchFee = null;
  if (merchFee > 0) {
    tMerchFee = await recordWalletTransferWithIds(conn, {
      fromId: merch.wallet_id,
      toId: admin.wallet_id,
      amount: merchFee,
      note: `Platform fee (merchant 50%) for ${order_id}`,
      ids: ids2,
    });
  }

  await conn.query(
    `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
     VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
    [
      order_id,
      tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
      tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
      tOrder ? `${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null,
    ],
  );

  return {
    captured: true,
    payment_method: "WALLET",
    order_id,
    user_id: Number(order.user_id),
  };
}

async function captureOrderCODFeeWithConn(conn, order_id, prefetchedIds = []) {
  if (await captureExists(order_id, "COD_FEE", conn)) {
    return { captured: false, alreadyCaptured: true, payment_method: "COD" };
  }

  const [[order]] = await conn.query(
    `SELECT user_id, payment_method
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );
  if (!order) throw new Error("Order not found for COD fee capture");

  if (String(order.payment_method || "").toUpperCase() !== "COD") {
    return { captured: false, skipped: true, payment_method: "COD" };
  }

  const split = await computeBusinessSplit(order_id, conn);
  const feeForPrimary = Number(split.platform_fee || 0);

  const userFee =
    feeForPrimary > 0
      ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
      : 0;
  const merchFee = Number((feeForPrimary - userFee).toFixed(2));

  const buyer = await getBuyerWalletByUserId(order.user_id, conn);
  const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
  const admin = await getAdminWallet(conn);

  if (!buyer) throw new Error("Buyer wallet missing");
  if (!merch) throw new Error("Merchant wallet missing");
  if (!admin) throw new Error("Admin wallet missing");

  if (userFee > 0) {
    const [[freshBuyer]] = await conn.query(
      `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
      [buyer.id],
    );
    if (!freshBuyer || Number(freshBuyer.amount) < userFee) {
      throw new Error(
        "Insufficient user wallet balance for COD platform fee share.",
      );
    }
  }

  if (merchFee > 0) {
    const [[freshMerch]] = await conn.query(
      `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
      [merch.id],
    );
    if (!freshMerch || Number(freshMerch.amount) < merchFee) {
      throw new Error(
        "Insufficient merchant wallet balance for COD platform fee share.",
      );
    }
  }

  const ids0 = prefetchedIds?.[0];
  const ids1 = prefetchedIds?.[1];
  if ((userFee > 0 && !ids0) || (merchFee > 0 && !ids1)) {
    throw new Error("Prefetched transaction ids are missing for COD capture");
  }

  let tUserFee = null;
  if (userFee > 0) {
    tUserFee = await recordWalletTransferWithIds(conn, {
      fromId: buyer.wallet_id,
      toId: admin.wallet_id,
      amount: userFee,
      note: `COD platform fee (user 50%) for ${order_id}`,
      ids: ids0,
    });
  }

  let tMerchFee = null;
  if (merchFee > 0) {
    tMerchFee = await recordWalletTransferWithIds(conn, {
      fromId: merch.wallet_id,
      toId: admin.wallet_id,
      amount: merchFee,
      note: `COD platform fee (merchant 50%) for ${order_id}`,
      ids: ids1,
    });
  }

  await conn.query(
    `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
     VALUES (?, 'COD_FEE', ?, ?, ?)`,
    [
      order_id,
      tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
      tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
      (tUserFee?.journal_id ? String(tUserFee.journal_id) : null) ||
        (tMerchFee?.journal_id ? String(tMerchFee.journal_id) : null) ||
        null,
    ],
  );

  return {
    captured: true,
    payment_method: "COD",
    order_id,
    user_id: Number(order.user_id),
  };
}

/* helper used by controller */
async function captureOnAccept(order_id, conn = null) {
  const dbh = conn || db;

  const [[order]] = await dbh.query(
    `SELECT user_id, payment_method
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );
  if (!order) return { ok: false, code: "NOT_FOUND" };

  const pm = String(order.payment_method || "WALLET").toUpperCase();

  if (pm === "WALLET")
    return {
      ok: true,
      payment_method: "WALLET",
      capture: await captureOrderFunds(order_id),
    };
  if (pm === "COD")
    return {
      ok: true,
      payment_method: "COD",
      capture: await captureOrderCODFee(order_id),
    };

  return { ok: true, payment_method: pm, skipped: true };
}

module.exports = {
  PLATFORM_USER_SHARE,
  PLATFORM_MERCHANT_SHARE,

  prefetchTxnIdsBatch,
  computeBusinessSplit,

  captureOrderFunds,
  captureOrderCODFee,
  captureOrderFundsWithConn,
  captureOrderCODFeeWithConn,
  captureOnAccept,
};
