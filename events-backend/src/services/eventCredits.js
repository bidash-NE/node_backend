const prisma = require('../db');

// Nu. granted to every new user on signup, redeemable only against event ticket purchases.
const SIGNUP_CREDIT_AMOUNT = 1400;

async function grantSignupCredit(userId) {
  await prisma.event_credits.create({
    data: { user_id: userId, balance: SIGNUP_CREDIT_AMOUNT, granted: SIGNUP_CREDIT_AMOUNT },
  });
}

async function getBalance(userId) {
  const credit = await prisma.event_credits.findUnique({ where: { user_id: BigInt(userId) } });
  return credit ? credit.balance : 0;
}

// Atomically redeems up to `amount` of the user's event credit against a ticket purchase.
// Returns the amount actually applied (may be less than requested if the balance is lower).
async function applyCredit(userId, amount, bookingId) {
  const requested = Math.floor(Number(amount));
  if (!(requested > 0)) return 0;

  return prisma.$transaction(async (tx) => {
    const credit = await tx.event_credits.findUnique({ where: { user_id: BigInt(userId) } });
    if (!credit || credit.balance <= 0) return 0;

    const applied = Math.min(credit.balance, requested);

    await tx.event_credits.update({
      where: { user_id: BigInt(userId) },
      data: { balance: { decrement: applied } },
    });
    await tx.event_credit_usages.create({
      data: { user_id: BigInt(userId), booking_id: bookingId ?? null, amount: applied },
    });

    return applied;
  });
}

// Reverses a previously applied credit (e.g. when the follow-on wallet charge fails).
async function refundCredit(userId, amount, bookingId) {
  const refund = Math.floor(Number(amount));
  if (!(refund > 0)) return;

  await prisma.$transaction([
    prisma.event_credits.update({
      where: { user_id: BigInt(userId) },
      data: { balance: { increment: refund } },
    }),
    prisma.event_credit_usages.create({
      data: { user_id: BigInt(userId), booking_id: bookingId ?? null, amount: -refund },
    }),
  ]);
}

module.exports = { SIGNUP_CREDIT_AMOUNT, grantSignupCredit, getBalance, applyCredit, refundCredit };
