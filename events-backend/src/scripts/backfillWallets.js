// One-time backfill: provisions a wallet for every existing user who doesn't
// have one yet. The wallet_payment service credits the signup bonus itself
// at creation time (see wallet_payment/models/walletModel.js), so no separate
// credit step is needed here.
// Run with: node src/scripts/backfillWallets.js
require('dotenv').config();
const prisma = require('../db');
const walletApi = require('../services/walletApi');

// wallet_payment rate-limits /wallet/create to 30 req / 2 min — stay under that.
const WALLET_CREATE_DELAY_MS = 4200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfill() {
  const users = await prisma.users.findMany({ select: { user_id: true } });
  console.log(`Checking ${users.length} user(s) for a missing wallet.`);

  let created = 0;
  let alreadyHadWallet = 0;
  let failures = 0;

  for (const { user_id } of users) {
    try {
      await walletApi.createWallet(user_id);
      created++;
    } catch (err) {
      if (err.status === 409) {
        alreadyHadWallet++;
      } else {
        failures++;
        console.error(`Wallet creation failed for user ${user_id}:`, err.message);
      }
    }

    await sleep(WALLET_CREATE_DELAY_MS);
  }

  console.log(`Done. Wallets created: ${created}. Already had a wallet: ${alreadyHadWallet}. Failures: ${failures}.`);
}

backfill()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
