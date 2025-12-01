// models/pointConversionModel.js
const pool = require("../config/db");
const axios = require("axios");

// Admin wallet that funds the conversion
const ADMIN_WALLET_ID = "NET000001";

// Endpoint that generates transaction_ids + journal_code
const WALLET_IDS_BOTH_ENDPOINT =
  process.env.WALLET_IDS_BOTH_ENDPOINT ||
  "https://grab.newedge.bt/wallet/ids/both";

/**
 * Get active conversion rule from point_conversion_rule (id = 1, is_active = 1)
 */
async function getActiveConversionRule() {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      points_required,
      wallet_amount,
      is_active,
      created_at,
      updated_at
    FROM point_conversion_rule
    WHERE id = 1 AND is_active = 1
    LIMIT 1
    `
  );
  return rows[0] || null;
}

/**
 * Convert user's points into wallet amount based on active rule.
 * Points source: users.points, amount column in wallets.
 *
 * Formula:
 *  - Require: pointsToConvert >= points_required
 *  - Require: pointsToConvert <= users.points
 *  - walletAmount = (pointsToConvert * wallet_amount_rule) / points_required
 *
 * Inserts:
 *  - 2 wallet_transactions rows (DR for admin, CR for user)
 *  - 1 notifications row for user
 *
 * Returns:
 *  {
 *    points_converted,
 *    wallet_amount,
 *    transaction_ids,
 *    journal_code,
 *    calculation: {
 *      points_required,
 *      wallet_per_block,
 *      points_requested,
 *      total_points_before,
 *      total_points_after,
 *      amount_per_point,
 *      formula,
 *      leftover_points
 *    }
 *  }
 */
async function convertPointsToWallet(userId, pointsToConvert) {
  // 1. Load active conversion rule
  const rule = await getActiveConversionRule();
  if (!rule) {
    const err = new Error(
      "Point conversion rule is not configured or is inactive."
    );
    err.code = "RULE_NOT_FOUND";
    throw err;
  }

  if (!rule.is_active) {
    const err = new Error("Point conversion rule is inactive.");
    err.code = "RULE_INACTIVE";
    throw err;
  }

  const pointsRequired = Number(rule.points_required);
  const walletPerBlock = Number(rule.wallet_amount); // amount for pointsRequired

  if (
    !Number.isInteger(pointsRequired) ||
    pointsRequired <= 0 ||
    !Number.isFinite(walletPerBlock) ||
    walletPerBlock <= 0
  ) {
    const err = new Error("Invalid point conversion rule configuration.");
    err.code = "RULE_INVALID_CONFIG";
    throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    /* -----------------------
       2. Lock user row (users.points)
    ------------------------*/
    const [userRows] = await conn.query(
      `
      SELECT user_id, points
      FROM users
      WHERE user_id = ?
      FOR UPDATE
      `,
      [userId]
    );

    if (!userRows || userRows.length === 0) {
      const err = new Error("User not found.");
      err.code = "USER_NOT_FOUND";
      throw err;
    }

    const currentPoints = Number(userRows[0].points || 0);

    // >= rule minimum
    if (pointsToConvert < pointsRequired) {
      const err = new Error(
        `Minimum points required for conversion is ${pointsRequired}. You requested ${pointsToConvert} points.`
      );
      err.code = "NOT_ENOUGH_POINTS_FOR_CONVERSION";
      throw err;
    }

    // must not exceed user's available points
    if (pointsToConvert > currentPoints) {
      const err = new Error(
        `Insufficient points. You have ${currentPoints} points and tried to convert ${pointsToConvert}.`
      );
      err.code = "INSUFFICIENT_USER_POINTS";
      throw err;
    }

    // 3. Compute wallet amount using formula
    const amountPerPoint = walletPerBlock / pointsRequired; // e.g. 100/500 = 0.2
    const walletAmountRaw = pointsToConvert * amountPerPoint;
    const walletAmount = Number(walletAmountRaw.toFixed(2)); // 2-decimal

    if (walletAmount <= 0) {
      const err = new Error("Calculated wallet amount is not valid.");
      err.code = "RULE_INVALID_CONFIG";
      throw err;
    }

    const newPointsBalance = currentPoints - pointsToConvert;

    /* -----------------------
       4. Lock admin wallet (amount)
    ------------------------*/
    const [adminWalletRows] = await conn.query(
      `
      SELECT wallet_id, amount
      FROM wallets
      WHERE wallet_id = ?
      FOR UPDATE
      `,
      [ADMIN_WALLET_ID]
    );

    if (!adminWalletRows || adminWalletRows.length === 0) {
      const err = new Error("Admin wallet not found.");
      err.code = "ADMIN_WALLET_NOT_FOUND";
      throw err;
    }

    const adminAmount = Number(adminWalletRows[0].amount || 0);
    if (adminAmount < walletAmount) {
      const err = new Error(
        "Admin wallet has insufficient balance to process conversion."
      );
      err.code = "ADMIN_WALLET_INSUFFICIENT";
      throw err;
    }

    /* -----------------------
       5. Lock user wallet (amount)
    ------------------------*/
    const [userWalletRows] = await conn.query(
      `
      SELECT wallet_id, amount
      FROM wallets
      WHERE user_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [userId]
    );

    if (!userWalletRows || userWalletRows.length === 0) {
      const err = new Error("User wallet not found.");
      err.code = "USER_WALLET_NOT_FOUND";
      throw err;
    }

    const userWalletId = userWalletRows[0].wallet_id;
    const userWalletAmount = Number(userWalletRows[0].amount || 0);

    /* -----------------------
       6. Update user points (users.points)
    ------------------------*/
    await conn.query(
      `
      UPDATE users
      SET points = ?
      WHERE user_id = ?
      `,
      [newPointsBalance, userId]
    );

    /* -----------------------
       7. Update wallet amounts (wallets.amount)
    ------------------------*/
    const newAdminAmount = adminAmount - walletAmount;
    const newUserAmount = userWalletAmount + walletAmount;

    await conn.query(
      `
      UPDATE wallets
      SET amount = ?
      WHERE wallet_id = ?
      `,
      [newAdminAmount, ADMIN_WALLET_ID]
    );

    await conn.query(
      `
      UPDATE wallets
      SET amount = ?
      WHERE wallet_id = ?
      `,
      [newUserAmount, userWalletId]
    );

    /* -----------------------
       8. Fetch transaction_ids + journal_code
          from https://grab.newedge.bt/wallet/ids/both
    ------------------------*/
    let transactionIds = [];
    let journalCode = null;

    try {
      const resp = await axios.post(WALLET_IDS_BOTH_ENDPOINT, {});
      const payload = resp.data || {};

      if (
        !payload.ok ||
        !payload.data ||
        !Array.isArray(payload.data.transaction_ids) ||
        !payload.data.journal_code
      ) {
        const err = new Error(
          "Failed to fetch transaction ids and journal code."
        );
        err.code = "TXN_ID_FETCH_FAILED";
        throw err;
      }

      transactionIds = payload.data.transaction_ids;
      journalCode = payload.data.journal_code;
    } catch (e) {
      console.error("Error calling wallet ids endpoint:", e);
      const err = new Error(
        "Unable to generate transaction/journal codes for wallet transaction."
      );
      err.code = "TXN_ID_FETCH_FAILED";
      throw err;
    }

    const adminTxnId = transactionIds[0];
    const userTxnId = transactionIds[1] || transactionIds[0];

    /* -----------------------
       9. Insert wallet_transactions
       - one DR row for admin wallet
       - one CR row for user wallet
       NOTE: we DO NOT insert actual_wallet_id (auto/default in DB).
    ------------------------*/

    // Admin DEBIT
    await conn.query(
      `
      INSERT INTO wallet_transactions (
        transaction_id,
        journal_code,
        tnx_from,
        tnx_to,
        amount,
        remark,
        note,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'DR', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
      `,
      [
        adminTxnId,
        journalCode,
        ADMIN_WALLET_ID,
        userWalletId,
        walletAmount,
        `Points conversion to ${userWalletId}`,
      ]
    );

    // User CREDIT
    await conn.query(
      `
      INSERT INTO wallet_transactions (
        transaction_id,
        journal_code,
        tnx_from,
        tnx_to,
        amount,
        remark,
        note,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'CR', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
      `,
      [
        userTxnId,
        journalCode,
        ADMIN_WALLET_ID,
        userWalletId,
        walletAmount,
        `Points conversion from ${ADMIN_WALLET_ID}`,
      ]
    );

    /* -----------------------
       10. Insert notification for user
       notifications table:
       (user_id, type, title, message, data, status, created_at)
    ------------------------*/
    const notifyTitle = "Transaction successful";
    const notifyMessage = `Your account has been credited with Nu. ${walletAmount.toFixed(
      2
    )} from acc ${ADMIN_WALLET_ID} to ${userWalletId}.`;

    const notifyData = {
      to: userWalletId,
      from: ADMIN_WALLET_ID,
      amount: walletAmount,
      source: "points_conversion",
      journal_code: journalCode,
      transaction_ids: transactionIds,
      points_converted: pointsToConvert,
    };

    await conn.query(
      `
      INSERT INTO notifications (
        user_id,
        type,
        title,
        message,
        data,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 'unread', UTC_TIMESTAMP())
      `,
      [
        userId,
        "wallet_credit",
        notifyTitle,
        notifyMessage,
        JSON.stringify(notifyData),
      ]
    );

    /* -----------------------
       11. Commit
    ------------------------*/
    await conn.commit();
    conn.release();

    return {
      points_converted: pointsToConvert,
      wallet_amount: walletAmount,
      transaction_ids: transactionIds,
      journal_code: journalCode,
      calculation: {
        points_required: pointsRequired,
        wallet_per_block: walletPerBlock,
        points_requested: pointsToConvert,
        total_points_before: currentPoints,
        total_points_after: newPointsBalance,
        amount_per_point: amountPerPoint,
        formula: `amount = (points * ${walletPerBlock}) / ${pointsRequired}`,
        leftover_points: newPointsBalance,
      },
    };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    conn.release();
    throw err;
  }
}

module.exports = {
  convertPointsToWallet,
};
