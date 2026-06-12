// models/orders/walletCaptureEngine.js
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

function round2(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function splitPlatformFee(platformFeeTotal) {
  const fee = round2(platformFeeTotal);

  if (!(fee > 0)) {
    return {
      userFee: 0,
      merchFee: 0,
    };
  }

  const userFee = round2(fee * PLATFORM_USER_SHARE);
  const merchFee = round2(fee - userFee);

  return {
    userFee,
    merchFee,
  };
}

/**
 * Model:
 * orders.total_amount = gross payable
 * total_amount = order + delivery - discount + full platform fee
 *
 * Wallet movement:
 * Buyer    -> Merchant = total_amount - full platform_fee
 * Buyer    -> Admin    = 50% platform_fee
 * Merchant -> Admin    = 50% platform_fee
 *
 * Optional:
 * Admin -> Merchant = merchant_delivery_fee
 */
function computeWalletAmounts(order) {
  const finalTotalAmount = round2(order.total_amount);
  const platformFeeTotal = round2(order.platform_fee);
  const merchantDeliveryFee = round2(order.merchant_delivery_fee);

  if (!(finalTotalAmount > 0)) {
    throw new Error("Invalid total_amount for wallet capture");
  }

  if (platformFeeTotal < 0 || merchantDeliveryFee < 0) {
    throw new Error("Invalid negative fee amount for wallet capture");
  }

  const { userFee, merchFee } = splitPlatformFee(platformFeeTotal);

  const buyerToMerchant = round2(finalTotalAmount - platformFeeTotal);

  if (buyerToMerchant < 0) {
    throw new Error("Invalid wallet split: platform_fee exceeds total_amount");
  }

  const needFromBuyer = round2(buyerToMerchant + userFee);

  return {
    finalTotalAmount,
    platformFeeTotal,
    merchantDeliveryFee,
    buyerToMerchant,
    userFee,
    merchFee,
    needFromBuyer,
  };
}

async function captureExists(order_id, capture_type, conn = null) {
  const dbh = conn || db;

  const [[row]] = await dbh.query(
    `SELECT order_id
       FROM order_wallet_captures
      WHERE order_id = ?
        AND capture_type = ?
      LIMIT 1`,
    [order_id, capture_type],
  );

  return !!row;
}

async function computeBusinessSplit(order_id, conn = null) {
  const dbh = conn || db;

  const [items] = await dbh.query(
    `SELECT business_id, subtotal
       FROM order_items
      WHERE order_id = ?
      ORDER BY menu_id ASC`,
    [order_id],
  );

  if (!items.length) {
    throw new Error("Order has no items");
  }

  const primaryBizId = Number(items[0].business_id);

  if (!Number.isFinite(primaryBizId) || primaryBizId <= 0) {
    throw new Error("Unable to identify merchant business for wallet capture");
  }

  const subtotalTotal = items.reduce(
    (sum, item) => round2(sum + Number(item.subtotal || 0)),
    0,
  );

  return {
    business_id: primaryBizId,
    items_total: subtotalTotal,
  };
}

async function recordWalletTransfer(
  conn,
  { fromId, toId, amount, note = null },
) {
  const amt = round2(amount);

  if (!(amt > 0)) return null;

  const [dr] = await conn.query(
    `UPDATE wallets
        SET amount = amount - ?
      WHERE wallet_id = ?
        AND amount >= ?`,
    [amt, fromId, amt],
  );

  if (!dr.affectedRows) {
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);
  }

  await conn.query(
    `UPDATE wallets
        SET amount = amount + ?
      WHERE wallet_id = ?`,
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

  return {
    dr_txn_id: dr_id,
    cr_txn_id: cr_id,
    journal_id: journal_id || null,
  };
}

async function recordWalletTransferWithIds(
  conn,
  { fromId, toId, amount, note = null, ids },
) {
  const amt = round2(amount);

  if (!(amt > 0)) return null;

  const { dr_id, cr_id, journal_id } = ids || {};

  if (!dr_id || !cr_id) {
    throw new Error("Prefetched transaction ids missing: dr_id/cr_id");
  }

  const [dr] = await conn.query(
    `UPDATE wallets
        SET amount = amount - ?
      WHERE wallet_id = ?
        AND amount >= ?`,
    [amt, fromId, amt],
  );

  if (!dr.affectedRows) {
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);
  }

  await conn.query(
    `UPDATE wallets
        SET amount = amount + ?
      WHERE wallet_id = ?`,
    [amt, toId],
  );

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

  return {
    dr_txn_id: dr_id,
    cr_txn_id: cr_id,
    journal_id: journal_id || null,
  };
}

async function lockAndGetOrder(conn, order_id) {
  const [[order]] = await conn.query(
    `SELECT user_id, total_amount, platform_fee, merchant_delivery_fee, payment_method
       FROM orders
      WHERE order_id = ?
      FOR UPDATE`,
    [order_id],
  );

  return order || null;
}

/* ============================================================
   WALLET capture - standalone
============================================================ */

async function captureOrderFunds(order_id) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const order = await lockAndGetOrder(conn, order_id);

    if (!order) {
      throw new Error("Order not found for capture");
    }

    if (await captureExists(order_id, "WALLET_FULL", conn)) {
      await conn.commit();

      return {
        captured: false,
        alreadyCaptured: true,
        payment_method: "WALLET",
        order_id,
      };
    }

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

    const split = await computeBusinessSplit(order_id, conn);

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merchant = await getMerchantWalletByBusinessId(
      split.business_id,
      conn,
    );
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merchant) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const {
      finalTotalAmount,
      platformFeeTotal,
      merchantDeliveryFee,
      buyerToMerchant,
      userFee,
      merchFee,
      needFromBuyer,
    } = computeWalletAmounts(order);

    console.log("[WALLET CAPTURE AMOUNTS]", {
      order_id,
      total_amount_from_db: finalTotalAmount,
      platform_fee_from_db: platformFeeTotal,
      buyer_to_merchant: buyerToMerchant,
      buyer_platform_fee: userFee,
      merchant_platform_fee: merchFee,
      buyer_total_debit: needFromBuyer,
      merchant_delivery_fee: merchantDeliveryFee,
    });

    const [[freshBuyer]] = await conn.query(
      `SELECT amount
         FROM wallets
        WHERE id = ?
        FOR UPDATE`,
      [buyer.id],
    );

    if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
      throw new Error("Insufficient wallet balance during capture");
    }

    // 1. Buyer pays merchant: gross total minus full platform fee
    const tOrder = await recordWalletTransfer(conn, {
      fromId: buyer.wallet_id,
      toId: merchant.wallet_id,
      amount: buyerToMerchant,
      note: `Order + delivery amount credited to merchant for ${order_id}`,
    });

    // 2. Buyer pays 50% platform fee to admin
    let tUserFee = null;
    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        note: `Platform fee user share 50% for ${order_id}`,
      });
    }

    // 3. Merchant pays 50% platform fee to admin
    let tMerchFee = null;
    if (merchFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merchant.wallet_id,
        toId: admin.wallet_id,
        amount: merchFee,
        note: `Platform fee merchant share 50% for ${order_id}`,
      });
    }

    // 4. Optional platform/admin support for merchant delivery fee
    let tMerchantDelivery = null;
    if (merchantDeliveryFee > 0) {
      tMerchantDelivery = await recordWalletTransfer(conn, {
        fromId: admin.wallet_id,
        toId: merchant.wallet_id,
        amount: merchantDeliveryFee,
        note: `Merchant delivery fee support for ${order_id}`,
      });
    }

    const buyerTxnRef = [
      tOrder ? `order:${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null,
      tUserFee
        ? `buyer_platform:${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
        : null,
    ]
      .filter(Boolean)
      .join("|");

    const merchantTxnRef = [
      tMerchFee
        ? `merchant_platform:${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
        : null,
      tMerchantDelivery
        ? `merchant_delivery:${tMerchantDelivery.dr_txn_id}/${tMerchantDelivery.cr_txn_id}`
        : null,
    ]
      .filter(Boolean)
      .join("|");

    const adminTxnRef = [
      tUserFee
        ? `buyer_platform:${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
        : null,
      tMerchFee
        ? `merchant_platform:${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
        : null,
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
        buyerTxnRef || null,
        merchantTxnRef || null,
        adminTxnRef || null,
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
      buyer_total_debit: needFromBuyer,

      txns: {
        buyer_to_merchant_order: tOrder,
        buyer_to_admin_platform_fee: tUserFee,
        merchant_to_admin_platform_fee: tMerchFee,
        admin_to_merchant_delivery: tMerchantDelivery,
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

/* ============================================================
   COD capture - standalone
============================================================ */

async function captureOrderCODFee(order_id) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const order = await lockAndGetOrder(conn, order_id);

    if (!order) {
      throw new Error("Order not found for COD fee capture");
    }

    if (await captureExists(order_id, "COD_FEE", conn)) {
      await conn.commit();

      return {
        captured: false,
        alreadyCaptured: true,
        payment_method: "COD",
        order_id,
      };
    }

    const pm = String(order.payment_method || "").toUpperCase();

    if (pm !== "COD") {
      await conn.commit();

      return {
        captured: false,
        skipped: true,
        payment_method: pm,
        reason: "payment_method != COD",
      };
    }

    const split = await computeBusinessSplit(order_id, conn);

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merchant = await getMerchantWalletByBusinessId(
      split.business_id,
      conn,
    );
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merchant) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const { userFee, merchFee } = splitPlatformFee(order.platform_fee);

    let tUserFee = null;
    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        note: `COD platform fee user share 50% for ${order_id}`,
      });
    }

    let tMerchFee = null;
    if (merchFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merchant.wallet_id,
        toId: admin.wallet_id,
        amount: merchFee,
        note: `COD platform fee merchant share 50% for ${order_id}`,
      });
    }

    await conn.query(
      `INSERT INTO order_wallet_captures
         (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
       VALUES (?, 'COD_FEE', ?, ?, ?)`,
      [
        order_id,
        tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
        tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
        [
          tUserFee
            ? `buyer_platform:${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
            : null,
          tMerchFee
            ? `merchant_platform:${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
            : null,
        ]
          .filter(Boolean)
          .join("|") || null,
      ],
    );

    await conn.commit();

    return {
      captured: true,
      payment_method: "COD",
      order_id,
      user_id: Number(order.user_id),
      business_id: Number(split.business_id),
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

/* ============================================================
   WALLET capture inside existing transaction
============================================================ */

async function captureOrderFundsWithConn(conn, order_id, prefetchedIds = []) {
  const order = await lockAndGetOrder(conn, order_id);

  if (!order) {
    throw new Error("Order not found for wallet capture");
  }

  if (await captureExists(order_id, "WALLET_FULL", conn)) {
    return {
      captured: false,
      alreadyCaptured: true,
      payment_method: "WALLET",
      order_id,
    };
  }

  const pm = String(order.payment_method || "").toUpperCase();

  if (pm !== "WALLET") {
    return {
      captured: false,
      skipped: true,
      payment_method: pm || "WALLET",
    };
  }

  const split = await computeBusinessSplit(order_id, conn);

  const buyer = await getBuyerWalletByUserId(order.user_id, conn);
  const merchant = await getMerchantWalletByBusinessId(split.business_id, conn);
  const admin = await getAdminWallet(conn);

  if (!buyer) throw new Error("Buyer wallet missing");
  if (!merchant) throw new Error("Merchant wallet missing");
  if (!admin) throw new Error("Admin wallet missing");

  const {
    finalTotalAmount,
    platformFeeTotal,
    merchantDeliveryFee,
    buyerToMerchant,
    userFee,
    merchFee,
    needFromBuyer,
  } = computeWalletAmounts(order);

  console.log("[WALLET CAPTURE WITH CONN AMOUNTS]", {
    order_id,
    total_amount_from_db: finalTotalAmount,
    platform_fee_from_db: platformFeeTotal,
    buyer_to_merchant: buyerToMerchant,
    buyer_platform_fee: userFee,
    merchant_platform_fee: merchFee,
    buyer_total_debit: needFromBuyer,
    merchant_delivery_fee: merchantDeliveryFee,
  });

  const [[freshBuyer]] = await conn.query(
    `SELECT amount
       FROM wallets
      WHERE id = ?
      FOR UPDATE`,
    [buyer.id],
  );

  if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
    throw new Error("Insufficient wallet balance during capture");
  }

  const nextIds = async (index) => {
    if (prefetchedIds?.[index]) return prefetchedIds[index];
    return fetchTxnAndJournalIds();
  };

  const tOrder = await recordWalletTransferWithIds(conn, {
    fromId: buyer.wallet_id,
    toId: merchant.wallet_id,
    amount: buyerToMerchant,
    note: `Order + delivery amount credited to merchant for ${order_id}`,
    ids: await nextIds(0),
  });

  let tUserFee = null;
  if (userFee > 0) {
    tUserFee = await recordWalletTransferWithIds(conn, {
      fromId: buyer.wallet_id,
      toId: admin.wallet_id,
      amount: userFee,
      note: `Platform fee user share 50% for ${order_id}`,
      ids: await nextIds(1),
    });
  }

  let tMerchFee = null;
  if (merchFee > 0) {
    tMerchFee = await recordWalletTransferWithIds(conn, {
      fromId: merchant.wallet_id,
      toId: admin.wallet_id,
      amount: merchFee,
      note: `Platform fee merchant share 50% for ${order_id}`,
      ids: await nextIds(2),
    });
  }

  let tMerchantDelivery = null;
  if (merchantDeliveryFee > 0) {
    tMerchantDelivery = await recordWalletTransferWithIds(conn, {
      fromId: admin.wallet_id,
      toId: merchant.wallet_id,
      amount: merchantDeliveryFee,
      note: `Merchant delivery fee support for ${order_id}`,
      ids: await nextIds(3),
    });
  }

  await conn.query(
    `INSERT INTO order_wallet_captures
       (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
     VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
    [
      order_id,
      [
        tOrder ? `order:${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null,
        tUserFee
          ? `buyer_platform:${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
          : null,
      ]
        .filter(Boolean)
        .join("|") || null,
      [
        tMerchFee
          ? `merchant_platform:${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
          : null,
        tMerchantDelivery
          ? `merchant_delivery:${tMerchantDelivery.dr_txn_id}/${tMerchantDelivery.cr_txn_id}`
          : null,
      ]
        .filter(Boolean)
        .join("|") || null,
      [
        tUserFee
          ? `buyer_platform:${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
          : null,
        tMerchFee
          ? `merchant_platform:${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
          : null,
        tMerchantDelivery
          ? `merchant_delivery:${tMerchantDelivery.dr_txn_id}/${tMerchantDelivery.cr_txn_id}`
          : null,
      ]
        .filter(Boolean)
        .join("|") || null,
    ],
  );

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
    buyer_total_debit: needFromBuyer,

    txns: {
      buyer_to_merchant_order: tOrder,
      buyer_to_admin_platform_fee: tUserFee,
      merchant_to_admin_platform_fee: tMerchFee,
      admin_to_merchant_delivery: tMerchantDelivery,
    },
  };
}

/* ============================================================
   COD capture inside existing transaction
============================================================ */

async function captureOrderCODFeeWithConn(conn, order_id, prefetchedIds = []) {
  const order = await lockAndGetOrder(conn, order_id);

  if (!order) {
    throw new Error("Order not found for COD fee capture");
  }

  if (await captureExists(order_id, "COD_FEE", conn)) {
    return {
      captured: false,
      alreadyCaptured: true,
      payment_method: "COD",
      order_id,
    };
  }

  const pm = String(order.payment_method || "").toUpperCase();

  if (pm !== "COD") {
    return {
      captured: false,
      skipped: true,
      payment_method: pm || "COD",
    };
  }

  const split = await computeBusinessSplit(order_id, conn);

  const buyer = await getBuyerWalletByUserId(order.user_id, conn);
  const merchant = await getMerchantWalletByBusinessId(split.business_id, conn);
  const admin = await getAdminWallet(conn);

  if (!buyer) throw new Error("Buyer wallet missing");
  if (!merchant) throw new Error("Merchant wallet missing");
  if (!admin) throw new Error("Admin wallet missing");

  const { userFee, merchFee } = splitPlatformFee(order.platform_fee);

  const nextIds = async (index) => {
    if (prefetchedIds?.[index]) return prefetchedIds[index];
    return fetchTxnAndJournalIds();
  };

  let tUserFee = null;
  if (userFee > 0) {
    tUserFee = await recordWalletTransferWithIds(conn, {
      fromId: buyer.wallet_id,
      toId: admin.wallet_id,
      amount: userFee,
      note: `COD platform fee user share 50% for ${order_id}`,
      ids: await nextIds(0),
    });
  }

  let tMerchFee = null;
  if (merchFee > 0) {
    tMerchFee = await recordWalletTransferWithIds(conn, {
      fromId: merchant.wallet_id,
      toId: admin.wallet_id,
      amount: merchFee,
      note: `COD platform fee merchant share 50% for ${order_id}`,
      ids: await nextIds(1),
    });
  }

  await conn.query(
    `INSERT INTO order_wallet_captures
       (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
     VALUES (?, 'COD_FEE', ?, ?, ?)`,
    [
      order_id,
      tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
      tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
      [
        tUserFee
          ? `buyer_platform:${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
          : null,
        tMerchFee
          ? `merchant_platform:${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
          : null,
      ]
        .filter(Boolean)
        .join("|") || null,
    ],
  );

  return {
    captured: true,
    payment_method: "COD",
    order_id,
    user_id: Number(order.user_id),
    business_id: Number(split.business_id),
    platform_fee_user: userFee,
    platform_fee_merchant: merchFee,
  };
}

/* ============================================================
   Helper used by controller
============================================================ */

async function captureOnAccept(order_id, conn = null) {
  const dbh = conn || db;

  const [[order]] = await dbh.query(
    `SELECT user_id, payment_method
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );

  if (!order) {
    return {
      ok: false,
      code: "NOT_FOUND",
    };
  }

  const pm = String(order.payment_method || "WALLET").toUpperCase();

  if (pm === "WALLET") {
    return {
      ok: true,
      payment_method: "WALLET",
      capture: await captureOrderFunds(order_id),
    };
  }

  if (pm === "COD") {
    return {
      ok: true,
      payment_method: "COD",
      capture: await captureOrderCODFee(order_id),
    };
  }

  return {
    ok: true,
    payment_method: pm,
    skipped: true,
  };
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