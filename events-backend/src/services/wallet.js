const prisma = require('../db');

const SYSTEM_WALLET_ID = 'TD00000001';

function generateTransactionId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TNX${ts}A${rand}`;
}

function generateJournalCode() {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `JRNEVT${rand}`;
}

// Get wallet by user_id — throws if not found or inactive
async function getWallet(userId, tx = prisma) {
  const wallet = await tx.wallets.findUnique({
    where: { user_id: BigInt(userId) },
  });
  if (!wallet) {
    const err = new Error('Wallet not found for this user'); err.status = 404; throw err;
  }
  if (wallet.status !== 'ACTIVE') {
    const err = new Error('Wallet is inactive'); err.status = 403; throw err;
  }
  return wallet;
}

// Deduct amount from wallet and record DR transaction — call inside a $transaction
async function debitWallet(tx, userId, amount, journalCode, note) {
  const wallet = await tx.wallets.findUnique({
    where: { user_id: BigInt(userId) },
  });

  if (!wallet || wallet.status !== 'ACTIVE') {
    const err = new Error('Wallet not found or inactive'); err.status = 404; throw err;
  }
  if (Number(wallet.amount) < amount) {
    const err = new Error(`Insufficient wallet balance. Available: BTN ${wallet.amount}, Required: BTN ${amount}`);
    err.status = 402; throw err;
  }

  // Deduct from wallet balance
  await tx.wallets.update({
    where: { user_id: BigInt(userId) },
    data: { amount: { decrement: amount } },
  });

  // DR — debit from user wallet
  // CR — credit to system wallet
  // Both share the same journal_code to link them
  await tx.wallet_transactions.createMany({
    data: [
      {
        transaction_id: generateTransactionId(),
        journal_code:   journalCode,
        tnx_from:       wallet.wallet_id,
        tnx_to:         SYSTEM_WALLET_ID,
        amount,
        remark:         'DR',
        note,
      },
      {
        transaction_id: generateTransactionId(),
        journal_code:   journalCode,
        tnx_from:       wallet.wallet_id,
        tnx_to:         SYSTEM_WALLET_ID,
        amount,
        remark:         'CR',
        note,
      },
    ],
  });

  return wallet;
}

// Refund amount to wallet and record CR transaction — call inside a $transaction
async function creditWallet(tx, userId, amount, journalCode, note) {
  const wallet = await tx.wallets.findUnique({
    where: { user_id: BigInt(userId) },
  });

  if (!wallet) {
    const err = new Error('Wallet not found'); err.status = 404; throw err;
  }

  // Add to wallet balance
  await tx.wallets.update({
    where: { user_id: BigInt(userId) },
    data: { amount: { increment: amount } },
  });

  // DR — debit from system wallet (refund out)
  // CR — credit back to user wallet
  await tx.wallet_transactions.createMany({
    data: [
      {
        transaction_id: generateTransactionId(),
        journal_code:   journalCode,
        tnx_from:       SYSTEM_WALLET_ID,
        tnx_to:         wallet.wallet_id,
        amount,
        remark:         'DR',
        note,
      },
      {
        transaction_id: generateTransactionId(),
        journal_code:   journalCode,
        tnx_from:       SYSTEM_WALLET_ID,
        tnx_to:         wallet.wallet_id,
        amount,
        remark:         'CR',
        note,
      },
    ],
  });
}

// Get wallet balance for a user
async function getBalance(userId) {
  const wallet = await prisma.wallets.findUnique({
    where: { user_id: BigInt(userId) },
    select: { wallet_id: true, amount: true, status: true },
  });
  return wallet;
}

module.exports = { getWallet, debitWallet, creditWallet, getBalance, generateJournalCode };
