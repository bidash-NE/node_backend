// models/userTransferModel.js
const axios = require("axios");
const { prisma } = require("../lib/prisma");

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
  const url = String(process.env.WALLET_IDS_BOTH_URL || "").trim();

  if (!url) {
    throw new Error("WALLET_IDS_BOTH_URL missing in env");
  }

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

  return {
    transaction_ids,
    journal_code,
  };
}

/* ---------------- helpers ---------------- */

function toDecimalNumber(v) {
  if (v == null) return 0;

  if (typeof v === "number") return v;

  if (typeof v === "bigint") return Number(v);

  if (typeof v === "string") return Number(v);

  if (
    typeof v === "object" &&
    typeof v.toString === "function" &&
    v.constructor?.name === "Decimal"
  ) {
    return Number(v.toString());
  }

  return Number(v);
}

function normalizeAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
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

function transactionCreateData(data) {
  const fields = prismaModelFields("wallet_transactions");

  const out = {
    transaction_id: data.transaction_id,
    journal_code: data.journal_code,
    tnx_from: data.tnx_from,
    tnx_to: data.tnx_to,
    amount: data.amount,
    remark: data.remark,
    note: data.note,
  };

  const now = new Date();

  // Only include these if your Prisma model exposes these fields.
  if (fields.has("created_at")) out.created_at = now;
  if (fields.has("updated_at")) out.updated_at = now;

  return out;
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
  try {
    // 1) Fetch transaction IDs + journal code from external service
    // Kept outside DB transaction, same as your old code.
    const { transaction_ids, journal_code } = await fetchTxIdsAndJournalCode();

    const [txIdDr, txIdCr] = transaction_ids;

    const amt = normalizeAmount(amount_nu);

    if (!Number.isFinite(amt) || amt <= 0) {
      return {
        ok: false,
        status: 400,
        message: "Invalid amount.",
      };
    }

    return await prisma.$transaction(async (tx) => {
      /* ----------------- FETCH SENDER ----------------- */
      const sender = await tx.wallets.findUnique({
        where: {
          wallet_id: String(sender_wallet_id).trim(),
        },
        select: {
          id: true,
          wallet_id: true,
          amount: true,
          status: true,
        },
      });

      if (!sender) {
        return {
          ok: false,
          status: 404,
          message: "Sender wallet not found.",
        };
      }

      /* ----------------- FETCH RECIPIENT ----------------- */
      const recipient = await tx.wallets.findUnique({
        where: {
          wallet_id: String(recipient_wallet_id).trim(),
        },
        select: {
          id: true,
          wallet_id: true,
          amount: true,
          status: true,
        },
      });

      if (!recipient) {
        return {
          ok: false,
          status: 404,
          message: "Recipient wallet not found.",
        };
      }

      if (String(sender.status || "").toUpperCase() !== "ACTIVE") {
        return {
          ok: false,
          status: 403,
          message: "Sender wallet is not ACTIVE.",
        };
      }

      if (String(recipient.status || "").toUpperCase() !== "ACTIVE") {
        return {
          ok: false,
          status: 403,
          message: "Recipient wallet is not ACTIVE.",
        };
      }

      if (toDecimalNumber(sender.amount) < amt) {
        return {
          ok: false,
          status: 400,
          message: "Insufficient balance in sender wallet.",
        };
      }

      /*
       * Atomic debit protection:
       * This prevents overdraft even if two transfers hit the same wallet together.
       */
      const debitResult = await tx.wallets.updateMany({
        where: {
          id: Number(sender.id),
          wallet_id: String(sender_wallet_id).trim(),
          status: "ACTIVE",
          amount: {
            gte: amt,
          },
        },
        data: {
          amount: {
            decrement: amt,
          },
        },
      });

      if (Number(debitResult.count || 0) !== 1) {
        return {
          ok: false,
          status: 400,
          message: "Insufficient balance in sender wallet.",
        };
      }

      /* ----------------- CREDIT RECIPIENT ----------------- */
      const creditResult = await tx.wallets.updateMany({
        where: {
          id: Number(recipient.id),
          wallet_id: String(recipient_wallet_id).trim(),
          status: "ACTIVE",
        },
        data: {
          amount: {
            increment: amt,
          },
        },
      });

      if (Number(creditResult.count || 0) !== 1) {
        throw new Error("Failed to credit recipient wallet.");
      }

      /* ----------------- INSERT DR (Sender) ----------------- */
      await tx.wallet_transactions.create({
        data: transactionCreateData({
          transaction_id: txIdDr,
          journal_code,
          tnx_from: String(sender_wallet_id).trim(),
          tnx_to: String(recipient_wallet_id).trim(),
          amount: amt,
          remark: "DR",
          note: note || "",
        }),
      });

      /* ----------------- INSERT CR (Recipient) ----------------- */
      await tx.wallet_transactions.create({
        data: transactionCreateData({
          transaction_id: txIdCr,
          journal_code,
          tnx_from: String(sender_wallet_id).trim(),
          tnx_to: String(recipient_wallet_id).trim(),
          amount: amt,
          remark: "CR",
          note: note || "",
        }),
      });

      /* ----------------- GET UPDATED BALANCES ----------------- */
      const senderNew = await tx.wallets.findUnique({
        where: {
          id: Number(sender.id),
        },
        select: {
          amount: true,
        },
      });

      const recipientNew = await tx.wallets.findUnique({
        where: {
          id: Number(recipient.id),
        },
        select: {
          amount: true,
        },
      });

      return {
        ok: true,
        status: 200,
        message: "Transfer completed.",
        journal_code,
        transaction_ids,
        sender_balance: toDecimalNumber(senderNew?.amount),
        recipient_balance: toDecimalNumber(recipientNew?.amount),
      };
    });
  } catch (err) {
    console.error("Error in userWalletTransfer:", err);

    return {
      ok: false,
      status: 500,
      message: err.message,
    };
  }
}

module.exports = {
  userWalletTransfer,
};