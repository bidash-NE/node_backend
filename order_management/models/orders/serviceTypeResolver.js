// models/orders/serviceTypeResolver.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Uses your actual Prisma schema:
//    - orders.service_type
//    - order_items.business_id
//    - merchant_business_details.owner_type

const { prisma } = require("../../lib/prisma");
const { ensureServiceTypeSupport } = require("./schemaSupport");

/* ======================= HELPERS ======================= */

function getClient(client = null) {
  /*
    Supports:
    - normal prisma
    - Prisma transaction client

    If an old MySQL conn is passed, ignore it and use normal prisma.
  */
  if (
    client &&
    (typeof client.orders?.findUnique === "function" ||
      typeof client.order_items?.findFirst === "function" ||
      typeof client.merchant_business_details?.findUnique === "function")
  ) {
    return client;
  }

  return prisma;
}

function normalizeOrderId(order_id) {
  return String(order_id || "").trim().toUpperCase();
}

function normalizeOwnerType(owner_type) {
  const raw = String(owner_type || "").trim();

  if (!raw) return null;

  const upper = raw.toUpperCase();

  if (upper === "FOOD") return "FOOD";
  if (upper === "MART") return "MART";

  const lower = raw.toLowerCase();

  if (lower.includes("mart")) return "MART";
  if (lower.includes("food")) return "FOOD";

  return null;
}

function normalizeServiceType(service_type) {
  const s = String(service_type || "").trim().toUpperCase();

  if (s === "FOOD") return "FOOD";
  if (s === "MART") return "MART";

  return null;
}

/* ======================= SERVICE TYPE RESOLUTION ======================= */

// Uses merchant_business_details.owner_type to derive FOOD/MART
// when orders.service_type is missing/null.
async function getOwnerTypeByBusinessId(business_id, client = null) {
  const tx = getClient(client);

  const bid = Number(business_id);

  if (!Number.isFinite(bid) || bid <= 0) {
    return null;
  }

  const row = await tx.merchant_business_details.findUnique({
    where: {
      business_id: BigInt(bid),
    },
    select: {
      owner_type: true,
    },
  });

  return normalizeOwnerType(row?.owner_type);
}

async function resolveOrderServiceType(order_id, client = null) {
  const tx = getClient(client);
  const oid = normalizeOrderId(order_id);

  if (!oid) {
    return "FOOD";
  }

  // If orders.service_type exists and is filled, use it.
  try {
    const hasService = await ensureServiceTypeSupport();

    if (hasService) {
      const row = await tx.orders.findUnique({
        where: {
          order_id: oid,
        },
        select: {
          service_type: true,
        },
      });

      const st = normalizeServiceType(row?.service_type);

      if (st) {
        return st;
      }
    }
  } catch {
    // Continue to derive from order_items.
  }

  // Otherwise derive from primary business_id in order_items.
  const primary = await tx.order_items.findFirst({
    where: {
      order_id: oid,
    },
    select: {
      business_id: true,
    },
    orderBy: {
      menu_id: "asc",
    },
  });

  const derived = primary?.business_id
    ? await getOwnerTypeByBusinessId(primary.business_id, tx)
    : null;

  return derived || "FOOD";
}

module.exports = {
  getOwnerTypeByBusinessId,
  resolveOrderServiceType,
};