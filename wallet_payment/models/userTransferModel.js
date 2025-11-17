// models/userTransferModel.js
const db = require("../config/db");
const axios = require("axios");

/**
 * POST https://grab.newedge.bt/wallet/ids/both
 * returns:
 * {
 *   ok: true,
 *   data: {
 *     transaction_ids: [ "TNX...", "TNX..." ],
 *     journal_code: "JRN..."
 *   }
 * }
 */
async function fetchTxIdsAndJournalCode() {
  const url =
    process.env.WALLET_IDS_BOTH_URL ||
    "https://grab.newedge.bt/wallet/ids/both";

  const resp = await axios.post(url, {}, { timeout: 5000 });

  if (!resp.data || !resp.data.ok || !resp.data.data) {
    throw new Error("Invalid response from wallet/ids/both");
  }

  const { transaction_ids, journal_code } = resp.data.data;

  if (!Array.isArray(transaction_ids) || transaction_ids.length < 2) {
    throw new Error("wallet/ids/both did not return valid transaction_ids");
  }

  if (!journal_code) {
    throw new Error("wallet/ids/both did not return journal_code");
  }

  return { transaction_ids, journal_code };
}

/**
 * Wallet-to-wallet transfer logic
 * Inserts two rows:
 *  - DR (sender)
 *  - CR (recipient)
 */
async function userWalletTransfer({
  sender_wallet_id,
  recipient_wallet_id,
  amount_nu,
  note = "",
}) {
  // 1) Fetch transaction IDs + journal code from external service
  const { transaction_ids, journal_code } = await fetchTxIdsAndJournalCode();

  const [txIdDr, txIdCr] = transaction_ids;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    /* ----------------- LOCK SENDER ----------------- */
    const [senderRows] = await conn.query(
      "SELECT id, wallet_id, amount, status FROM wallets WHERE wallet_id = ? FOR UPDATE",
      [sender_wallet_id]
    );
    if (!senderRows.length) {
      await conn.rollback();
      return { ok: false, status: 404, message: "Sender wallet not found." };
    }
    const sender = senderRows[0];

    /* ----------------- LOCK RECIPIENT ----------------- */
    const [recipientRows] = await conn.query(
      "SELECT id, wallet_id, amount, status FROM wallets WHERE wallet_id = ? FOR UPDATE",
      [recipient_wallet_id]
    );
    if (!recipientRows.length) {
      await conn.rollback();
      return {
        ok: false,
        status: 404,
        message: "Recipient wallet not found.",
      };
    }
    const recipient = recipientRows[0];

    if (sender.status !== "ACTIVE") {
      await conn.rollback();
      return {
        ok: false,
        status: 403,
        message: "Sender wallet is not ACTIVE.",
      };
    }

    if (recipient.status !== "ACTIVE") {
      await conn.rollback();
      return {
        ok: false,
        status: 403,
        message: "Recipient wallet is not ACTIVE.",
      };
    }

    const amt = Number(amount_nu);
    if (isNaN(amt) || amt <= 0) {
      await conn.rollback();
      return { ok: false, status: 400, message: "Invalid amount." };
    }

    if (Number(sender.amount) < amt) {
      await conn.rollback();
      return {
        ok: false,
        status: 400,
        message: "Insufficient balance in sender wallet.",
      };
    }

    const newSenderBal = Number(sender.amount) - amt;
    const newRecipientBal = Number(recipient.amount) + amt;

    /* ----------------- UPDATE BALANCES ----------------- */
    await conn.query("UPDATE wallets SET amount = ? WHERE id = ?", [
      newSenderBal,
      sender.id,
    ]);

    await conn.query("UPDATE wallets SET amount = ? WHERE id = ?", [
      newRecipientBal,
      recipient.id,
    ]);

    /* ----------------- INSERT DR (Sender) ----------------- */
    await conn.query(
      `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
      [txIdDr, journal_code, sender_wallet_id, recipient_wallet_id, amt, note]
    );

    /* ----------------- INSERT CR (Recipient) ----------------- */
    await conn.query(
      `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
      [txIdCr, journal_code, sender_wallet_id, recipient_wallet_id, amt, note]
    );

    await conn.commit();

    return {
      ok: true,
      status: 200,
      message: "Transfer completed.",
      journal_code,
      transaction_ids,
      sender_balance: newSenderBal,
      recipient_balance: newRecipientBal,
    };
  } catch (err) {
    await conn.rollback();
    console.error("Error in userWalletTransfer:", err);
    return {
      ok: false,
      status: 500,
      message: err.message,
    };
  } finally {
    conn.release();
  }
}

module.exports = {
  userWalletTransfer,
};
