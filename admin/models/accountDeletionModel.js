const { prisma } = require("../lib/prisma.js");

async function findPendingByUser(user_id) {
  return prisma.account_deletion_requests.findFirst({
    where: { user_id: Number(user_id), status: "pending" },
    select: { request_id: true, status: true, requested_at: true },
  });
}

async function createRequest(user_id, reason) {
  return prisma.account_deletion_requests.create({
    data: {
      user_id: Number(user_id),
      reason: reason || null,
      status: "pending",
    },
    select: { request_id: true, status: true, requested_at: true },
  });
}

async function getLatestByUser(user_id) {
  return prisma.account_deletion_requests.findFirst({
    where: { user_id: Number(user_id) },
    orderBy: { requested_at: "desc" },
    select: {
      request_id: true,
      status: true,
      requested_at: true,
      resolved_at: true,
      reject_note: true,
    },
  });
}

async function listRequests({ status, page, limit }) {
  const where = status && status !== "all" ? { status } : {};
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    prisma.account_deletion_requests.count({ where }),
    prisma.account_deletion_requests.findMany({
      where,
      skip,
      take: limit,
      orderBy: { requested_at: "desc" },
      select: {
        request_id: true,
        user_id: true,
        reason: true,
        status: true,
        requested_at: true,
        resolved_at: true,
        resolved_by: true,
        reject_note: true,
        users: {
          select: { user_name: true, email: true, phone: true },
        },
      },
    }),
  ]);

  return {
    total,
    data: rows.map((r) => ({
      request_id: Number(r.request_id),
      user_id: Number(r.user_id),
      user_name: r.users?.user_name ?? null,
      email: r.users?.email ?? null,
      phone: r.users?.phone ?? null,
      reason: r.reason,
      status: r.status,
      requested_at: r.requested_at,
      resolved_at: r.resolved_at,
      resolved_by: r.resolved_by ? Number(r.resolved_by) : null,
      reject_note: r.reject_note,
    })),
  };
}

async function findRequestById(request_id) {
  return prisma.account_deletion_requests.findUnique({
    where: { request_id: Number(request_id) },
    include: { users: { select: { user_id: true, user_name: true } } },
  });
}

async function approveAndDeleteUser(request_id, resolved_by) {
  const req = await findRequestById(request_id);
  if (!req) return { notFound: true };
  if (req.status !== "pending") return { alreadyResolved: true };

  const uid = Number(req.user_id);

  // Get wallet_id before deleting anything
  const wallet = await prisma.wallets.findUnique({
    where: { user_id: uid },
    select: { wallet_id: true },
  });

  // Preserve audit trail: null-out user_id in admin_logs rather than deleting rows
  await prisma.admin_logs.updateMany({
    where: { user_id: uid },
    data: { user_id: null },
  });

  // Wallet data (no cascade from users table)
  await prisma.wallet_transaction_logs.deleteMany({ where: { user_id: uid } });
  await prisma.wallet_ledger.deleteMany({ where: { user_id: uid } });
  await prisma.wallet_holds.deleteMany({ where: { user_id: uid } });
  if (wallet?.wallet_id) {
    await prisma.wallet_transactions.deleteMany({
      where: { OR: [{ tnx_from: wallet.wallet_id }, { tnx_to: wallet.wallet_id }] },
    });
  }
  await prisma.wallets.deleteMany({ where: { user_id: uid } });

  // Mark approved before deleting user — the FK is SetNull, so after user deletion
  // user_id becomes NULL automatically, but status/resolved_at are preserved.
  await prisma.account_deletion_requests.update({
    where: { request_id: Number(request_id) },
    data: {
      status: "approved",
      resolved_at: new Date(),
      resolved_by: resolved_by ? Number(resolved_by) : null,
    },
  });

  // Delete the user — Prisma cascade removes related rows; account_deletion_requests.user_id → SetNull
  await prisma.users.delete({ where: { user_id: uid } });

  return { deleted: true, user_id: uid };
}

async function rejectRequest(request_id, resolved_by, reject_note) {
  const req = await findRequestById(request_id);
  if (!req) return { notFound: true };
  if (req.status !== "pending") return { alreadyResolved: true };

  const updated = await prisma.account_deletion_requests.update({
    where: { request_id: Number(request_id) },
    data: {
      status: "rejected",
      resolved_at: new Date(),
      resolved_by: resolved_by ? Number(resolved_by) : null,
      reject_note,
    },
    select: {
      request_id: true,
      status: true,
      reject_note: true,
      resolved_at: true,
    },
  });

  return { rejected: true, data: updated };
}

module.exports = {
  findPendingByUser,
  createRequest,
  getLatestByUser,
  listRequests,
  approveAndDeleteUser,
  rejectRequest,
};
