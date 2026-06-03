// models/orders/helpers.js
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Keeps same exported function names for compatibility

const { prisma } = require("../../lib/prisma");
const axios = require("axios");

/* ======================= UTILS ======================= */

function generateOrderId() {
  const n = Math.floor(10000000 + Math.random() * 90000000);
  return `ORD-${n}`;
}

const fmtNu = (n) => Number(n || 0).toFixed(2);

function getPrismaClient(client = null) {
  return client || prisma;
}

/**
 * Checks whether a Prisma model has a field.
 * This replaces INFORMATION_SCHEMA.COLUMNS raw SQL checks.
 */
function prismaModelHasField(modelName, fieldName) {
  try {
    const model = prisma?._runtimeDataModel?.models?.[modelName];

    if (!model || !Array.isArray(model.fields)) {
      return false;
    }

    return model.fields.some((field) => field.name === fieldName);
  } catch {
    return false;
  }
}

/* ======================= SCHEMA SUPPORT FLAGS ======================= */

let _hasStatusReason = null;

async function ensureStatusReasonSupport(_client = null) {
  if (_hasStatusReason !== null) return _hasStatusReason;

  _hasStatusReason = prismaModelHasField("orders", "status_reason");
  return _hasStatusReason;
}

let _hasServiceType = null;

async function ensureServiceTypeSupport(_client = null) {
  if (_hasServiceType !== null) return _hasServiceType;

  _hasServiceType = prismaModelHasField("orders", "service_type");
  return _hasServiceType;
}

let _deliveryExtrasSupport = null;

async function ensureDeliveryExtrasSupport(_client = null) {
  if (_deliveryExtrasSupport !== null) return _deliveryExtrasSupport;

  _deliveryExtrasSupport = {
    hasLat: prismaModelHasField("orders", "delivery_lat"),
    hasLng: prismaModelHasField("orders", "delivery_lng"),
    hasFloor: prismaModelHasField("orders", "delivery_floor_unit"),
    hasInstr: prismaModelHasField("orders", "delivery_instruction_note"),
    hasMode: prismaModelHasField("orders", "delivery_special_mode"),
    hasPhoto: prismaModelHasField("orders", "delivery_photo_url"),
    hasPhotoList: prismaModelHasField("orders", "delivery_photo_urls"),
    hasDeliveryStatus: prismaModelHasField("orders", "delivery_status"),
    hasDeliveredAt: prismaModelHasField("orders", "delivered_at"),
    hasBatchId: prismaModelHasField("orders", "delivery_batch_id"),
    hasDriverId: prismaModelHasField("orders", "delivery_driver_id"),
    hasRideId: prismaModelHasField("orders", "delivery_ride_id"),
  };

  return _deliveryExtrasSupport;
}

/* ================= HTTP & ID SERVICE HELPERS ================= */

async function postJson(url, body = {}, timeout = 8000) {
  if (!url) {
    throw new Error("Wallet ID service URL is missing in env.");
  }

  try {
    const { data } = await axios.post(url, body, {
      timeout,
      headers: {
        "Content-Type": "application/json",
      },
    });

    return data;
  } catch (e) {
    const status = e?.response?.status;
    const resp = e?.response?.data;

    const respText =
      resp == null
        ? ""
        : typeof resp === "string"
          ? resp.slice(0, 300)
          : JSON.stringify(resp).slice(0, 300);

    throw new Error(
      `Wallet ID service POST failed: ${url} ${
        status ? `(HTTP ${status})` : ""
      } ${e?.message || ""} ${respText}`,
    );
  }
}

function extractIdsShape(payload) {
  const p = payload?.data ? payload.data : payload;

  let txn_ids = null;

  if (Array.isArray(p?.transaction_ids) && p.transaction_ids.length >= 2) {
    txn_ids = [String(p.transaction_ids[0]), String(p.transaction_ids[1])];
  } else if (Array.isArray(p?.txn_ids) && p.txn_ids.length >= 2) {
    txn_ids = [String(p.txn_ids[0]), String(p.txn_ids[1])];
  }

  const journal =
    p?.journal_id || p?.journal || p?.journal_code || p?.journalCode || null;

  return {
    txn_ids,
    journal_id: journal || null,
  };
}

async function fetchTxnAndJournalIds({ IDS_BOTH_URL }, timeout = 8000) {
  const data = await postJson(IDS_BOTH_URL, {}, timeout);
  const { txn_ids, journal_id } = extractIdsShape(data);

  if (txn_ids && txn_ids.length >= 2) {
    return {
      dr_id: txn_ids[0],
      cr_id: txn_ids[1],
      journal_id,
    };
  }

  throw new Error(
    `Wallet ID service returned unexpected payload: ${JSON.stringify(data).slice(
      0,
      500,
    )}`,
  );
}

/**
 * Prefetch transaction IDs outside DB transaction.
 */
async function prefetchTxnIdsBatch(n, { IDS_BOTH_URL }, timeout = 8000) {
  const count = Number(n);

  if (!Number.isInteger(count) || count <= 0) {
    return [];
  }

  const out = [];

  for (let i = 0; i < count; i++) {
    out.push(await fetchTxnAndJournalIds({ IDS_BOTH_URL }, timeout));
  }

  return out;
}

/* ================= SERVICE TYPE RESOLUTION ================= */

/**
 * Uses merchant_business_details.owner_type to derive FOOD/MART.
 * client can be prisma or transaction client.
 */
async function getOwnerTypeByBusinessId(business_id, client = null) {
  const tx = getPrismaClient(client);

  const bid = Number(business_id);

  if (!Number.isFinite(bid) || bid <= 0) {
    return null;
  }

  const row = await tx.merchant_business_details.findUnique({
    where: {
      business_id: bid,
    },
    select: {
      owner_type: true,
    },
  });

  const ot = row?.owner_type;

  if (!ot) return null;

  const norm = String(ot).trim().toUpperCase();

  if (norm === "FOOD" || norm === "MART") return norm;

  const lower = String(ot).toLowerCase();

  if (lower.includes("mart")) return "MART";
  if (lower.includes("food")) return "FOOD";

  return null;
}

/**
 * Resolve order service type.
 * 1. If orders.service_type exists and is FOOD/MART, use it.
 * 2. Otherwise derive from first order_items.business_id.
 * 3. Fallback FOOD.
 */
async function resolveOrderServiceType(order_id, client = null) {
  const tx = getPrismaClient(client);

  const oid = String(order_id || "").trim().toUpperCase();

  if (!oid) return "FOOD";

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

      const st = row?.service_type
        ? String(row.service_type).trim().toUpperCase()
        : "";

      if (st === "FOOD" || st === "MART") {
        return st;
      }
    }
  } catch {
    // Continue to derive from order_items.
  }

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

/* ================= OTHER HELPERS ================= */

function parseDeliveryAddress(val) {
  if (val == null) return null;

  if (typeof val === "object") {
    return val;
  }

  const str = String(val || "").trim();

  if (!str) return null;

  try {
    const obj = JSON.parse(str);

    return {
      address: obj.address ?? obj.addr ?? "",
      lat: typeof obj.lat === "number" ? obj.lat : Number(obj.lat ?? NaN),
      lng: typeof obj.lng === "number" ? obj.lng : Number(obj.lng ?? NaN),
    };
  } catch {
    return {
      address: str,
      lat: null,
      lng: null,
    };
  }
}

module.exports = {
  prisma,

  // utils
  generateOrderId,
  fmtNu,

  // schema helpers
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  ensureDeliveryExtrasSupport,

  // service type helpers
  getOwnerTypeByBusinessId,
  resolveOrderServiceType,

  // misc
  parseDeliveryAddress,

  // wallet id helpers
  postJson,
  extractIdsShape,
  fetchTxnAndJournalIds,
  prefetchTxnIdsBatch,
};