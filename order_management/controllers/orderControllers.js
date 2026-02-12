// controllers/orderControllers.js
// ✅ Controller that DOES NOT use `Order.`
// ✅ Imports functions directly from your /models/orders/* files
// ✅ Uses: const db = require("../config/db");
// ✅ Keeps: upload + notifications + push + wallet capture delivered pipeline

const db = require("../config/db");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");
const { MAX_PHOTOS } = require("../middleware/uploadDeliveryPhoto");

/* --------------------------- uploads support --------------------------- */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

/* --------------------------- Expo push (YOUR API SHAPE) --------------------------- */
const axios = require("axios");

const EXPO_NOTIFICATION_URL =
  process.env.EXPO_NOTIFICATION_URL ||
  "https://grab.newedge.bt/expo/api/push/send";

/* ============================================================
   Import model functions directly
   (Works whether modules export function directly or { fn } named)
============================================================ */

function pickFn(mod, name) {
  if (!mod) return null;
  if (typeof mod === "function") return mod; // module.exports = function
  if (name && typeof mod[name] === "function") return mod[name]; // module.exports = { name(){} }
  const first = Object.values(mod).find((v) => typeof v === "function");
  return first || null;
}

/* ---------------- CRUD ---------------- */
const _createMod = require("../models/orders/crud/create");
const _findAllMod = require("../models/orders/crud/findAll");
const _findByBusinessIdMod = require("../models/orders/crud/findByBusinessId");
const _findByOrderIdGroupedMod = require("../models/orders/crud/findByOrderIdGrouped");
const _findByUserIdForAppMod = require("../models/orders/crud/findByUserIdForApp");
const _updateMod = require("../models/orders/crud/update");
const _updateStatusMod = require("../models/orders/crud/updateStatus");
const _deleteMod = require("../models/orders/crud/delete");
const updateStatusWithUnavailable = require("../models/orders/crud/updateStatusWithUnavailable");
const _getOrderStatusCountsByBusinessMod = require("../models/orders/crud/getOrderStatusCountsByBusiness");
const _findByBusinessGroupedByUserMod = require("../models/orders/crud/findByBusinessGroupedByUser");

const createDb = pickFn(_createMod, "create");
const findAllDb = pickFn(_findAllMod, "findAll");
const findByBusinessIdDb = pickFn(_findByBusinessIdMod, "findByBusinessId");
const findByOrderIdGroupedDb = pickFn(
  _findByOrderIdGroupedMod,
  "findByOrderIdGrouped",
);
const findByUserIdForAppDb = pickFn(
  _findByUserIdForAppMod,
  "findByUserIdForApp",
);
const updateDb = pickFn(_updateMod, "update");
const updateStatusDb = pickFn(_updateStatusMod, "updateStatus");
const deleteDb =
  pickFn(_deleteMod, "delete") ||
  pickFn(_deleteMod, "del") ||
  pickFn(_deleteMod, "remove");
const getOrderStatusCountsByBusinessDb = pickFn(
  _getOrderStatusCountsByBusinessMod,
  "getOrderStatusCountsByBusiness",
);
const findByBusinessGroupedByUserDb = pickFn(
  _findByBusinessGroupedByUserMod,
  "findByBusinessGroupedByUser",
);

/* ---------------- pipelines / notifications / helpers ---------------- */
const _helpersMod = require("../models/orders/helpers");
const generateOrderId =
  (typeof _helpersMod?.generateOrderId === "function" &&
    _helpersMod.generateOrderId) ||
  (typeof _helpersMod === "function" ? _helpersMod : null);

const _archiveMod = require("../models/orders/orderArchivePipeline");
const completeAndArchiveDeliveredOrder =
  _archiveMod?.completeAndArchiveDeliveredOrder ||
  pickFn(_archiveMod, "completeAndArchiveDeliveredOrder");
const cancelAndArchiveOrder =
  _archiveMod?.cancelAndArchiveOrder ||
  pickFn(_archiveMod, "cancelAndArchiveOrder");

const _notifMod = require("../models/orders/orderNotifications");
const addUserOrderStatusNotification =
  _notifMod?.addUserOrderStatusNotification ||
  pickFn(_notifMod, "addUserOrderStatusNotification");
const addUserWalletDebitNotification =
  _notifMod?.addUserWalletDebitNotification ||
  pickFn(_notifMod, "addUserWalletDebitNotification");

/* ============================================================
   PUSH helpers
============================================================ */

/**
 * If it's business_id -> get merchant user_id from merchant_business_details
 */
async function resolveMerchantUserIdFromBusinessId(conn, business_id) {
  const bid = Number(business_id);
  if (!Number.isFinite(bid) || bid <= 0) return null;

  const [[row]] = await conn.query(
    `SELECT user_id
       FROM merchant_business_details
      WHERE business_id = ?
      LIMIT 1`,
    [bid],
  );

  const uid = row?.user_id != null ? Number(row.user_id) : null;
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}

/**
 * Supports multiple merchants across multiple business_ids
 */
async function getMerchantUserIdsByBusinessIds(businessIds = []) {
  const ids = Array.from(
    new Set(
      (businessIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );
  if (!ids.length) return [];

  try {
    const [rows] = await db.query(
      `SELECT DISTINCT user_id
         FROM merchant_business_details
        WHERE business_id IN (?)`,
      [ids],
    );

    return Array.from(
      new Set(
        rows
          .map((r) => Number(r.user_id))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
  } catch (e) {
    console.error("[getMerchantUserIdsByBusinessIds ERROR]", e?.message || e);
    return [];
  }
}

/**
 * ✅ IMPORTANT:
 * Your push API expects: { user_id: <number>, title: <string>, body: <string> }
 */
async function sendPushToUserId(user_id, { title, body }) {
  try {
    const uid = Number(user_id);
    if (!Number.isFinite(uid) || uid <= 0) return { ok: false, skipped: true };

    const payload = {
      user_id: uid,
      title: String(title || "Notification"),
      body: String(body || ""),
    };

    const { data } = await axios.post(EXPO_NOTIFICATION_URL, payload, {
      timeout: 8000,
      headers: { "Content-Type": "application/json" },
    });

    return { ok: true, data };
  } catch (e) {
    console.error("[PUSH FAILED]", e?.message || e);
    return { ok: false, error: e?.message || "push_failed" };
  }
}

/* ============================================================
   wallet+delivery notifications
============================================================ */

/**
 * Fallback: if capture doesn't include amounts (or is 0),
 * compute from DB like before:
 * - platform_fee_user = platform_fee * 0.5 (default)
 * - order_amount = total_amount - platform_fee
 */
async function resolveUserDebitAmounts(conn, order_id, user_id, capture = {}) {
  const out = {
    order_amount: Number(capture?.order_amount || 0),
    platform_fee_user: Number(
      capture?.platform_fee_user ??
        capture?.platform_fee_user_share ??
        capture?.platform_fee_user_amount ??
        0,
    ),
    platform_fee_total: Number(
      capture?.platform_fee ??
        capture?.final_platform_fee ??
        capture?.platform_fee_total ??
        0,
    ),
    total_amount: Number(
      capture?.total_amount ?? capture?.final_total_amount ?? 0,
    ),
  };

  // If amounts already look valid, keep them
  const looksValid =
    Number.isFinite(out.order_amount) &&
    out.order_amount > 0 &&
    Number.isFinite(out.platform_fee_user) &&
    out.platform_fee_user >= 0;

  if (looksValid) return out;

  try {
    // Prefer archive table first (because delivered pipeline often deletes from orders)
    let row = null;

    try {
      const [[r1]] = await conn.query(
        `SELECT total_amount, platform_fee
           FROM orders_archive
          WHERE order_id = ?
          LIMIT 1`,
        [order_id],
      );
      if (r1) row = r1;
    } catch {}

    if (!row) {
      const [[r2]] = await conn.query(
        `SELECT total_amount, platform_fee
           FROM orders
          WHERE order_id = ?
          LIMIT 1`,
        [order_id],
      );
      if (r2) row = r2;
    }

    if (!row) return out;

    const total_amount = Number(row.total_amount || 0);
    const platform_fee_total = Number(row.platform_fee || 0);

    const platform_fee_user = Number.isFinite(platform_fee_total)
      ? Number((platform_fee_total * 0.5).toFixed(2))
      : 0;

    // Order amount excludes the FULL platform fee (because platform fee is charged separately)
    const order_amount = Number.isFinite(total_amount)
      ? Number((total_amount - platform_fee_total).toFixed(2))
      : 0;

    // Only override missing/zero values
    if (!Number.isFinite(out.total_amount) || out.total_amount <= 0)
      out.total_amount = total_amount;
    if (!Number.isFinite(out.platform_fee_total) || out.platform_fee_total <= 0)
      out.platform_fee_total = platform_fee_total;

    if (!Number.isFinite(out.platform_fee_user) || out.platform_fee_user === 0)
      out.platform_fee_user = platform_fee_user;

    if (!Number.isFinite(out.order_amount) || out.order_amount === 0)
      out.order_amount = order_amount;

    return out;
  } catch (e) {
    console.error("[resolveUserDebitAmounts ERROR]", e?.message || e);
    return out;
  }
}

/**
 * After DELIVERED capture, write DB notifications + send PUSH
 * - Customer: wallet debit (order amount + platform fee share)
 * - Merchant: wallet credit (order credited) + merchant platform fee debit
 */
async function safeNotifyWalletAndDelivery(
  conn,
  { order_id, user_id, capture },
) {
  // customer wallet debit (DB + push)
  if (capture?.captured && user_id) {
    try {
      const method = String(capture.payment_method || "WALLET").toUpperCase();

      if (method === "WALLET") {
        const computed = await resolveUserDebitAmounts(
          conn,
          order_id,
          Number(user_id),
          capture,
        );

        const orderAmt = Number(computed.order_amount || 0);
        const feeAmt = Number(computed.platform_fee_user || 0);

        // DB notification (if function exists)
        if (typeof addUserWalletDebitNotification === "function") {
          await addUserWalletDebitNotification({
            user_id: Number(user_id),
            order_id,
            order_amount: orderAmt,
            platform_fee: feeAmt,
            method: "WALLET",
            conn,
          });
        }

        const bodyText =
          `Order ${order_id} delivered. ` +
          `Nu. ${Number(orderAmt || 0).toFixed(2)} deducted for order` +
          (feeAmt > 0
            ? ` and Nu. ${Number(feeAmt || 0).toFixed(2)} as platform fee.`
            : ".");

        await sendPushToUserId(Number(user_id), {
          title: "Wallet deduction",
          body: bodyText,
        });
      } else {
        await sendPushToUserId(Number(user_id), {
          title: "Order update",
          body: `Order ${order_id} delivered.`,
        });
      }
    } catch (e) {
      console.error("[notify user wallet debit failed]", e?.message);
    }
  }

  // merchant notification -> show wallet movements + DB + PUSH
  if (capture?.captured && capture?.business_id) {
    try {
      const merchantUserId = await resolveMerchantUserIdFromBusinessId(
        conn,
        capture.business_id,
      );

      if (merchantUserId) {
        const credited = Number(capture.order_amount || 0);
        const debited = Number(capture.platform_fee_merchant || 0);

        const parts = [];
        parts.push(`Order ${order_id} delivered.`);
        if (credited > 0)
          parts.push(`Nu. ${credited.toFixed(2)} credited to your wallet.`);
        if (debited > 0)
          parts.push(
            `Nu. ${debited.toFixed(2)} debited as platform fee (merchant share).`,
          );

        const msg = parts.join(" ");

        await conn.query(
          `INSERT INTO notifications (user_id, type, title, message, data, status, created_at)
           VALUES (?, 'wallet_update', 'Wallet updated', ?, ?, 'unread', NOW())`,
          [
            merchantUserId,
            msg,
            JSON.stringify({
              order_id,
              business_id: Number(capture.business_id),
              credited_order_amount: credited,
              debited_platform_fee_merchant: debited,
              payment_method: String(
                capture.payment_method || "WALLET",
              ).toUpperCase(),
            }),
          ],
        );

        await sendPushToUserId(merchantUserId, {
          title: "Wallet updated",
          body: msg,
        });
      }
    } catch (e) {
      console.error("[notify merchant wallet movement failed]", e?.message);
    }
  }
}

/* ============================================================
   upload setup
============================================================ */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const ORDERS_UPLOAD_DIR = path.join(UPLOAD_ROOT, "orders");

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}
ensureDir(ORDERS_UPLOAD_DIR);

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function guessExtFromMime(mime) {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

const PUBLIC_UPLOAD_BASE =
  (process.env.PUBLIC_UPLOAD_BASE || "/uploads").replace(/\/+$/, "") + "/";

function toPublicUploadUrl(absPath) {
  const rel = path.relative(UPLOAD_ROOT, absPath).split(path.sep).join("/");
  return `${PUBLIC_UPLOAD_BASE}${rel}`;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const orderId = String(req.body?.order_id || req.generated_order_id || "")
      .trim()
      .toUpperCase();
    const safeId = orderId && /^ORD-\d{8}$/.test(orderId) ? orderId : "TMP";
    const dir = path.join(ORDERS_UPLOAD_DIR, safeId);
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext =
      path.extname(file.originalname) || guessExtFromMime(file.mimetype);
    const name = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
    cb(null, name);
  },
});

function fileFilter(_req, file, cb) {
  if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
    return cb(new Error("Only image files are allowed (jpg, png, webp)."));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 4 * 1024 * 1024),
    files: Number(process.env.UPLOAD_MAX_FILES || 10),
  },
});

const uploadOrderImages = upload.any();

/* ============================================================
   helpers
============================================================ */

const ALLOWED_STATUSES = new Set([
  "ASSIGNED",
  "PENDING",
  "DECLINED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
]);

function normalizeServiceType(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  return s || null;
}
function normalizePaymentMethod(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  return s || null;
}
function normalizeFulfillment(v) {
  const s = String(v || "Delivery").trim();
  return s || "Delivery";
}
function normalizeSpecialMode(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  if (!s) return null;
  if (s === "DROP_OFF" || s === "DROPOFF" || s === "DROP") return "DROP_OFF";
  if (s === "MEET_UP" || s === "MEETUP" || s === "MEET") return "MEET_UP";
  return null;
}

function buildPreview(items = [], total_amount) {
  const parts = items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.item_name}`);
  const more = items.length > 2 ? `, +${items.length - 2} more` : "";
  const totalStr = Number(total_amount ?? 0).toFixed(2);
  return `${parts.join(", ")}${more} · Total Nu ${totalStr}`;
}

function normalizeItemShape(raw = {}, idx = 0) {
  const it = raw && typeof raw === "object" ? raw : {};

  const business_id =
    it.business_id ??
    it.businessId ??
    it.businessID ??
    it.business?.id ??
    it.business?.business_id ??
    it.business?.businessId ??
    null;

  const business_name =
    it.business_name ??
    it.businessName ??
    it.business?.name ??
    it.business?.business_name ??
    null;

  const menu_id =
    it.menu_id ??
    it.menuId ??
    it.product_id ??
    it.productId ??
    it.product?.id ??
    it.menu?.id ??
    it.item?.id ??
    null;

  const item_name =
    it.item_name ??
    it.name ??
    it.itemName ??
    it.product?.name ??
    it.menu?.name ??
    it.item?.name ??
    null;

  const quantity =
    it.quantity ?? it.qty ?? it.count ?? it.units ?? it.unit_count ?? null;
  const price =
    it.price ?? it.unit_price ?? it.unitPrice ?? it.rate ?? it.cost ?? null;

  const subtotal =
    it.subtotal ??
    it.line_subtotal ??
    it.lineSubtotal ??
    it.line_total ??
    it.lineTotal ??
    (quantity != null && price != null
      ? Number(quantity) * Number(price)
      : null);

  const item_image =
    it.item_image ??
    it.image ??
    it.itemImage ??
    it.product?.image ??
    it.product?.image_url ??
    it.menu?.image ??
    it.item?.image ??
    null;

  return {
    ...it,
    business_id,
    business_name,
    menu_id,
    item_name,
    item_image,
    quantity,
    price,
    subtotal,
    _index: idx,
  };
}

function mapUploadedFilesToPayload(req, order_id, items) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return { order_images: [], item_images: new Map() };

  const tmpDir = path.join(ORDERS_UPLOAD_DIR, "TMP");
  const finalDir = path.join(ORDERS_UPLOAD_DIR, order_id);
  ensureDir(finalDir);

  const orderImages = [];
  const itemImages = new Map();

  for (const f of files) {
    const field = String(f.fieldname || "");
    let absPath = f.path;

    try {
      if (absPath && absPath.startsWith(tmpDir + path.sep)) {
        const dest = path.join(finalDir, path.basename(absPath));
        fs.renameSync(absPath, dest);
        absPath = dest;
      }
    } catch {}

    const url = absPath ? toPublicUploadUrl(absPath) : null;
    if (!url) continue;

    if (
      field === "order_images" ||
      field === "order_image" ||
      field === "images"
    ) {
      orderImages.push(url);
      continue;
    }

    const idxMatch = field.match(/^item_image_(\d+)$/);
    if (idxMatch) {
      itemImages.set(Number(idxMatch[1]), url);
      continue;
    }

    const midMatch = field.match(/^item_image_(\d{1,10})$/);
    if (midMatch) {
      itemImages.set(String(midMatch[1]), url);
      continue;
    }
  }

  for (const it of items) {
    const idx = Number(it._index);
    const menuId = it.menu_id != null ? String(it.menu_id) : null;

    if (itemImages.has(idx)) it.item_image = itemImages.get(idx);
    else if (menuId && itemImages.has(menuId))
      it.item_image = itemImages.get(menuId);
  }

  return { order_images: orderImages, item_images: itemImages };
}

function parseMaybeJSON(v) {
  if (v == null) return v;
  if (typeof v !== "string") return v;

  const s = v.trim();
  if (!s) return v;
  if (!(s.startsWith("{") || s.startsWith("["))) return v;

  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

function getOrderInput(req) {
  let body = req.body || {};

  if (typeof body.payload === "string") {
    const p = parseMaybeJSON(body.payload);
    if (p && typeof p === "object") body = p;
  }

  body.items = parseMaybeJSON(body.items);
  body.delivery_address = parseMaybeJSON(body.delivery_address);

  const numFields = [
    "user_id",
    "total_amount",
    "discount_amount",
    "platform_fee",
    "delivery_fee",
    "merchant_delivery_fee",
  ];
  for (const k of numFields) {
    if (body[k] != null && body[k] !== "") body[k] = Number(body[k]);
  }

  return body;
}

function dedupeStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const s = (x == null ? "" : String(x)).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/* ============================================================
   controllers
============================================================ */

async function createOrder(req, res) {
  const safeUnlink = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  };

  const cleanupUploadedFiles = () => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      for (const f of files) safeUnlink(f?.path);
    } catch {}
  };

  try {
    const payload = getOrderInput(req);

    const itemsRaw = Array.isArray(payload.items) ? payload.items : [];
    if (!itemsRaw.length) {
      cleanupUploadedFiles();
      return res.status(400).json({ ok: false, message: "Missing items" });
    }

    if (!payload.user_id || !Number.isFinite(Number(payload.user_id))) {
      cleanupUploadedFiles();
      return res.status(400).json({ ok: false, message: "Missing user_id" });
    }

    const serviceType = normalizeServiceType(payload.service_type);
    if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
      cleanupUploadedFiles();
      return res.status(400).json({
        ok: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    const payMethod = normalizePaymentMethod(payload.payment_method);
    if (!payMethod || payMethod !== "WALLET") {
      cleanupUploadedFiles();
      return res.status(400).json({
        ok: false,
        message: "Invalid or missing payment_method. Allowed: WALLET",
      });
    }

    const normalizedItems = itemsRaw.map((it, idx) =>
      normalizeItemShape(it, idx),
    );

    const order_id = String(
      payload.order_id ||
        (generateOrderId ? generateOrderId() : `ORD-${Date.now()}`),
    )
      .trim()
      .toUpperCase();
    payload.order_id = order_id;

    const moved = mapUploadedFilesToPayload(req, order_id, normalizedItems);
    const uploadedOrderPhotos = Array.isArray(moved.order_images)
      ? moved.order_images
      : [];

    payload.delivery_floor_unit =
      payload.delivery_floor_unit ??
      payload.floor_unit ??
      payload.floorUnit ??
      null;
    payload.delivery_instruction_note =
      payload.delivery_instruction_note ??
      payload.special_instructions ??
      payload.delivery_note ??
      null;
    payload.delivery_special_mode = normalizeSpecialMode(
      payload.delivery_special_mode ?? payload.special_mode,
    );

    const fulfillment = normalizeFulfillment(payload.fulfillment_type);

    if (
      payload.delivery_address &&
      typeof payload.delivery_address === "object"
    ) {
      payload.delivery_address = JSON.stringify(payload.delivery_address);
    }

    const bodyList = Array.isArray(payload.delivery_photo_urls)
      ? payload.delivery_photo_urls
      : [];
    const bodySingle = payload.delivery_photo_url
      ? [payload.delivery_photo_url]
      : [];

    const allPhotos = dedupeStrings([
      ...bodyList,
      ...bodySingle,
      ...uploadedOrderPhotos,
    ]);

    if (allPhotos.length > MAX_PHOTOS) {
      cleanupUploadedFiles();
      return res.status(400).json({
        ok: false,
        message: `Maximum ${MAX_PHOTOS} photos are allowed.`,
        received: allPhotos.length,
      });
    }

    payload.delivery_photo_urls = allPhotos;
    payload.delivery_photo_url = allPhotos.length ? allPhotos[0] : null;

    // wallet balance check
    {
      const itemsSubtotal = normalizedItems.reduce(
        (s, it) =>
          s +
          Number(
            it.subtotal ||
              Number(it.quantity || 0) * Number(it.price || 0) ||
              0,
          ),
        0,
      );
      const deliveryFee = Number(payload.delivery_fee || 0);
      const discount = Number(payload.discount_amount || 0);
      const platformFee = Number(payload.platform_fee || 0);
      const computedTotal = Number(
        (itemsSubtotal + deliveryFee - discount + platformFee).toFixed(2),
      );

      const required =
        payload.total_amount != null && payload.total_amount !== ""
          ? Number(payload.total_amount)
          : computedTotal;

      const [[w]] = await db.query(
        `SELECT amount FROM wallets WHERE user_id = ? LIMIT 1`,
        [Number(payload.user_id)],
      );
      const balance = Number(w?.amount || 0);

      if (!Number.isFinite(required) || required <= 0) {
        cleanupUploadedFiles();
        return res.status(400).json({
          ok: false,
          code: "INVALID_TOTAL",
          message: "Invalid total_amount for wallet payment.",
        });
      }

      if (balance < required) {
        cleanupUploadedFiles();
        return res.status(400).json({
          ok: false,
          code: "INSUFFICIENT_WALLET_BALANCE",
          message:
            "Unable to place order because wallet balance is insufficient.",
          wallet_balance: Number(balance.toFixed(2)),
          required_total_amount: Number(required.toFixed(2)),
        });
      }
    }

    const status = String(payload.status || "PENDING")
      .trim()
      .toUpperCase();

    if (typeof createDb !== "function") {
      throw new Error("create() model function not found/exported.");
    }

    const created_id =
      createDb.length >= 2
        ? await createDb(db, {
            ...payload,
            service_type: serviceType,
            payment_method: "WALLET",
            fulfillment_type: fulfillment,
            status,
            items: normalizedItems,
          })
        : await createDb({
            ...payload,
            service_type: serviceType,
            payment_method: "WALLET",
            fulfillment_type: fulfillment,
            status,
            items: normalizedItems,
          });

    // business ids
    const byBiz = new Map();
    for (const it of normalizedItems) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const businessIds = Array.from(byBiz.keys());

    // DB + socket notifications for merchants
    for (const business_id of businessIds) {
      const its = byBiz.get(business_id) || [];
      const title = `New order #${created_id}`;
      const preview = buildPreview(its, payload.total_amount);

      try {
        await insertAndEmitNotification({
          business_id,
          user_id: payload.user_id,
          order_id: created_id,
          type: "order:create",
          title,
          body_preview: preview,
        });
      } catch (e) {
        console.error("[NOTIFY INSERT FAILED]", {
          order_id: created_id,
          business_id,
          err: e?.message,
        });
      }
    }

    // PUSH merchants
    try {
      const merchantUserIds =
        await getMerchantUserIdsByBusinessIds(businessIds);
      const title = `New order ${created_id}`;
      const bodyText = buildPreview(normalizedItems, payload.total_amount);

      for (const merchantUserId of merchantUserIds) {
        await sendPushToUserId(merchantUserId, { title, body: bodyText });
      }
    } catch (e) {
      console.error("[PUSH merchants new order FAILED]", e?.message || e);
    }

    broadcastOrderStatusToMany({
      order_id: created_id,
      user_id: payload.user_id,
      business_ids: businessIds,
      status,
    });

    return res.status(201).json({
      ok: true,
      order_id: created_id,
      delivery_photo_urls: payload.delivery_photo_urls || [],
      delivery_photo_url: payload.delivery_photo_url || null,
      delivery_floor_unit: payload.delivery_floor_unit || null,
      delivery_instruction_note: payload.delivery_instruction_note || null,
      delivery_special_mode: payload.delivery_special_mode || null,
    });
  } catch (err) {
    console.error("[createOrder ERROR]", err);
    cleanupUploadedFiles();
    return res.status(500).json({
      ok: false,
      message: "Unable to place order",
      error: err?.message || "Unknown error",
    });
  }
}

async function getOrders(_req, res) {
  try {
    if (typeof findAllDb !== "function")
      throw new Error("findAll() model function not found/exported.");
    const orders =
      findAllDb.length >= 1 ? await findAllDb(db) : await findAllDb();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOrderById(req, res) {
  try {
    if (typeof findByOrderIdGroupedDb !== "function")
      throw new Error(
        "findByOrderIdGrouped() model function not found/exported.",
      );

    const grouped =
      findByOrderIdGroupedDb.length >= 2
        ? await findByOrderIdGroupedDb(db, req.params.order_id)
        : await findByOrderIdGroupedDb(req.params.order_id);

    if (!grouped.length)
      return res.status(404).json({ message: "Order not found" });
    res.json({ success: true, data: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOrdersByBusinessId(req, res) {
  try {
    if (typeof findByBusinessIdDb !== "function")
      throw new Error("findByBusinessId() model function not found/exported.");

    const items =
      findByBusinessIdDb.length >= 2
        ? await findByBusinessIdDb(db, req.params.business_id)
        : await findByBusinessIdDb(req.params.business_id);

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getBusinessOrdersGroupedByUser(req, res) {
  try {
    if (typeof findByBusinessGroupedByUserDb !== "function")
      throw new Error(
        "findByBusinessGroupedByUser() model function not found/exported.",
      );

    const data =
      findByBusinessGroupedByUserDb.length >= 2
        ? await findByBusinessGroupedByUserDb(db, req.params.business_id)
        : await findByBusinessGroupedByUserDb(req.params.business_id);

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getOrdersForUser(req, res) {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id" });
    }

    if (typeof findByUserIdForAppDb !== "function")
      throw new Error(
        "findByUserIdForApp() model function not found/exported.",
      );

    let data =
      findByUserIdForAppDb.length >= 2
        ? await findByUserIdForAppDb(db, userId)
        : await findByUserIdForAppDb(userId);

    const qs = String(req.query?.service_type || "").trim();
    if (qs) {
      const st = qs.toUpperCase();
      if (!["FOOD", "MART"].includes(st)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service_type filter. Allowed: FOOD, MART",
        });
      }
      data = Array.isArray(data)
        ? data.filter((o) => String(o.service_type || "").toUpperCase() === st)
        : [];
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function updateOrder(req, res) {
  try {
    if (typeof updateDb !== "function")
      throw new Error("update() model function not found/exported.");

    const affectedRows =
      updateDb.length >= 3
        ? await updateDb(db, req.params.order_id, req.body)
        : await updateDb(req.params.order_id, req.body);

    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function updateEstimatedArrivalTime(order_id, estimated_minutes) {
  try {
    const mins = Number(estimated_minutes);
    if (!Number.isFinite(mins) || mins <= 0)
      throw new Error("Invalid estimated minutes");

    const now = new Date();
    const startDate = new Date(now.getTime() + mins * 60 * 1000);
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

    const BHUTAN_OFFSET_HOURS = 6;

    const toBhutanParts = (d) => {
      const hour24 = (d.getUTCHours() + BHUTAN_OFFSET_HOURS) % 24;
      const minute = d.getUTCMinutes();
      const meridiem = hour24 >= 12 ? "PM" : "AM";
      const hour12 = hour24 % 12 || 12;
      return { hour12, minute, meridiem };
    };

    const s = toBhutanParts(startDate);
    const e = toBhutanParts(endDate);

    const sStr = `${s.hour12}:${String(s.minute).padStart(2, "0")}`;
    const eStr = `${e.hour12}:${String(e.minute).padStart(2, "0")}`;

    const formattedRange =
      s.meridiem === e.meridiem
        ? `${sStr} - ${eStr} ${s.meridiem}`
        : `${sStr} ${s.meridiem} - ${eStr} ${e.meridiem}`;

    await db.query(
      `UPDATE orders SET estimated_arrivial_time = ? WHERE order_id = ?`,
      [formattedRange, order_id],
    );
  } catch (err) {
    console.error("[updateEstimatedArrivalTime ERROR]", err.message);
  }
}

/**
 * PUT /orders/:order_id/status
 */
async function updateOrderStatus(req, res) {
  try {
    const order_id = String(req.params.order_id || "")
      .trim()
      .toUpperCase();
    const body = req.body || {};
    const { status, reason, estimated_minutes, cancelled_by, delivered_by } =
      body;

    if (typeof status !== "string" || !status.trim()) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalizedRaw = status.trim().toUpperCase();
    const normalized =
      normalizedRaw === "COMPLETED" ? "DELIVERED" : normalizedRaw;

    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(", ")}`,
        received: normalizedRaw,
        normalized,
      });
    }

    const [[row]] = await db.query(
      `SELECT user_id, status AS current_status
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id],
    );

    if (!row) return res.status(404).json({ message: "Order not found" });

    const user_id = Number(row.user_id);
    const current = String(row.current_status || "PENDING").toUpperCase();
    const finalReason = String(reason || "").trim();

    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id],
    );
    const business_ids = bizRows
      .map((r) => Number(r.business_id))
      .filter((n) => Number.isFinite(n) && n > 0);

    // DELIVERED pipeline
    if (normalized === "DELIVERED") {
      req.body = {
        ...(req.body || {}),
        order_id,
        delivered_by: delivered_by || "SYSTEM",
        reason: finalReason || "",
      };
      return markOrderDelivered(req, res);
    }

    // CONFIRMED with unavailable changes
    if (normalized === "CONFIRMED") {
      const locked = new Set(["DELIVERED", "CANCELLED"]);
      if (locked.has(current)) {
        return res.status(400).json({
          success: false,
          message: `Order cannot be confirmed because it is already ${current}.`,
        });
      }

      const result = await updateStatusWithUnavailable(order_id, {
        status: "CONFIRMED",
        reason: finalReason,
        estimated_minutes: body.estimated_minutes ?? estimated_minutes,
        final_total_amount: body.final_total_amount,
        final_platform_fee: body.final_platform_fee,
        final_discount_amount: body.final_discount_amount,
        final_delivery_fee: body.final_delivery_fee,
        final_merchant_delivery_fee: body.final_merchant_delivery_fee,
        unavailable_changes:
          body.unavailable_changes &&
          typeof body.unavailable_changes === "object"
            ? body.unavailable_changes
            : { removed: [], replaced: [] },
      });

      if (!result?.ok) {
        if (result?.code === "NOT_FOUND") {
          return res
            .status(404)
            .json({ success: false, message: "Order not found" });
        }
        return res.status(400).json({
          success: false,
          message: result?.code || "Unable to confirm order",
          data: result || null,
        });
      }

      try {
        broadcastOrderStatusToMany({
          order_id,
          user_id,
          business_ids,
          status: "CONFIRMED",
        });
      } catch {}

      for (const business_id of business_ids) {
        try {
          await insertAndEmitNotification({
            business_id,
            user_id,
            order_id,
            type: "order:status",
            title: `Order #${order_id} CONFIRMED`,
            body_preview: result?.estimated_arrivial_time
              ? `ETA: ${result.estimated_arrivial_time}`
              : "Order accepted by merchant.",
          });
        } catch (e) {
          console.error("[merchant notify failed]", {
            order_id,
            business_id,
            err: e?.message,
          });
        }
      }

      try {
        const eta = result?.estimated_arrivial_time
          ? ` ETA: ${result.estimated_arrivial_time}`
          : "";
        await sendPushToUserId(user_id, {
          title: "Order Update",
          body: `Your order ${order_id} has been confirmed.${eta}`,
        });
      } catch {}

      try {
        if (typeof addUserOrderStatusNotification === "function") {
          await addUserOrderStatusNotification({
            user_id,
            order_id,
            status: "CONFIRMED",
            reason: finalReason,
          });
        }
      } catch (e) {
        console.error("[user notify failed]", { order_id, err: e?.message });
      }

      return res.json({
        success: true,
        message: "Order confirmed successfully",
        order_id,
        status: "CONFIRMED",
        data: result,
      });
    }

    // CANCEL restriction
    if (normalized === "CANCELLED") {
      const locked = new Set([
        "CONFIRMED",
        "PREPARING",
        "READY",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ]);
      if (locked.has(current)) {
        return res.status(400).json({
          message:
            "Order cannot be cancelled after it has been accepted by the merchant.",
        });
      }
    }

    // ETA update
    if (estimated_minutes != null) {
      await updateEstimatedArrivalTime(order_id, estimated_minutes);
    }

    if (typeof updateStatusDb !== "function")
      throw new Error("updateStatus() model function not found/exported.");

    const affected =
      updateStatusDb.length >= 4
        ? await updateStatusDb(db, order_id, normalized, finalReason)
        : await updateStatusDb(order_id, normalized, finalReason);

    if (!affected) return res.status(404).json({ message: "Order not found" });

    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids,
      status: normalized,
    });

    for (const business_id of business_ids) {
      try {
        await insertAndEmitNotification({
          business_id,
          user_id,
          order_id,
          type: "order:status",
          title: `Order #${order_id} ${normalized}`,
          body_preview: finalReason || `Status updated to ${normalized}.`,
        });
      } catch (e) {
        console.error("[merchant notify failed]", {
          order_id,
          business_id,
          err: e?.message,
        });
      }
    }

    try {
      await sendPushToUserId(user_id, {
        title: "Order Update",
        body:
          `Your order ${order_id} has been ${normalized.toLowerCase().replace(/_/g, " ")}.` +
          (finalReason ? ` Reason: ${finalReason}` : ""),
      });
    } catch {}

    try {
      const merchantUserIds =
        await getMerchantUserIdsByBusinessIds(business_ids);
      for (const merchantUserId of merchantUserIds) {
        await sendPushToUserId(merchantUserId, {
          title: "Order Update",
          body:
            `Order ${order_id} is now ${normalized}.` +
            (finalReason ? ` Reason: ${finalReason}` : ""),
        });
      }
    } catch {}

    try {
      if (typeof addUserOrderStatusNotification === "function") {
        await addUserOrderStatusNotification({
          user_id,
          order_id,
          status: normalized,
          reason: finalReason,
        });
      }
    } catch (e) {
      console.error("[user notify failed]", { order_id, err: e?.message });
    }

    if (normalized === "CANCELLED") {
      const by =
        String(cancelled_by || "SYSTEM")
          .trim()
          .toUpperCase() || "SYSTEM";
      return res.json({
        success: true,
        message: "Order cancelled successfully.",
        order_id,
        status: "CANCELLED",
        cancelled_by: by,
      });
    }

    return res.json({
      success: true,
      message: "Order status updated successfully",
      order_id,
      status: normalized,
    });
  } catch (err) {
    console.error("[updateOrderStatus ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
}

async function deleteOrder(req, res) {
  try {
    if (typeof deleteDb !== "function")
      throw new Error("delete() model function not found/exported.");

    const affectedRows =
      deleteDb.length >= 2
        ? await deleteDb(db, req.params.order_id)
        : await deleteDb(req.params.order_id);

    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOrderStatusCountsByBusiness(req, res) {
  try {
    const business_id = Number(req.params.business_id);
    if (!Number.isFinite(business_id) || business_id <= 0) {
      return res.status(400).json({ message: "Invalid business_id" });
    }

    if (typeof getOrderStatusCountsByBusinessDb !== "function")
      throw new Error(
        "getOrderStatusCountsByBusiness() model function not found/exported.",
      );

    const counts =
      getOrderStatusCountsByBusinessDb.length >= 2
        ? await getOrderStatusCountsByBusinessDb(db, business_id)
        : await getOrderStatusCountsByBusinessDb(business_id);

    return res.json(counts);
  } catch (err) {
    console.error("[getOrderStatusCountsByBusiness]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function cancelOrderByUser(req, res) {
  try {
    const user_id_param = Number(req.params.user_id);
    const order_id = req.params.order_id;
    const body = req.body || {};
    const userReason = String(body.reason || "").trim();

    if (!Number.isFinite(user_id_param) || user_id_param <= 0) {
      return res.status(400).json({ message: "Invalid user_id" });
    }

    const reason =
      userReason.length > 0
        ? `Cancelled by customer: ${userReason}`
        : "Cancelled by customer before the store accepted the order.";

    if (typeof cancelAndArchiveOrder !== "function")
      throw new Error("cancelAndArchiveOrder() pipeline not found/exported.");

    const out =
      cancelAndArchiveOrder.length >= 3
        ? await cancelAndArchiveOrder(db, order_id, {
            cancelled_by: "USER",
            reason,
            onlyIfStatus: "PENDING",
            expectedUserId: user_id_param,
          })
        : await cancelAndArchiveOrder(order_id, {
            cancelled_by: "USER",
            reason,
            onlyIfStatus: "PENDING",
            expectedUserId: user_id_param,
          });

    if (!out?.ok) {
      if (out?.code === "NOT_FOUND")
        return res.status(404).json({ message: "Order not found" });
      if (out?.code === "FORBIDDEN")
        return res
          .status(403)
          .json({ message: "You are not allowed to cancel this order." });

      if (out?.code === "SKIPPED") {
        return res.status(400).json({
          code: "CANNOT_CANCEL_AFTER_ACCEPT",
          message:
            "This order can no longer be cancelled because the store has already accepted it.",
          current_status: out.current_status,
        });
      }

      return res.status(400).json({ message: "Unable to cancel this order." });
    }

    broadcastOrderStatusToMany({
      order_id,
      user_id: out.user_id,
      business_ids: out.business_ids,
      status: "CANCELLED",
    });

    for (const business_id of out.business_ids || []) {
      try {
        await insertAndEmitNotification({
          business_id,
          user_id: out.user_id,
          order_id,
          type: "order:status",
          title: `Order #${order_id} CANCELLED`,
          body_preview: "Customer cancelled the order before acceptance.",
        });
      } catch (e) {
        console.error("[cancelOrderByUser notify merchant failed]", {
          order_id,
          business_id,
          err: e?.message,
        });
      }
    }

    try {
      await sendPushToUserId(out.user_id, {
        title: "Order Update",
        body: `Your order ${order_id} has been cancelled.${reason ? ` Reason: ${reason}` : ""}`,
      });
    } catch {}

    try {
      if (typeof addUserOrderStatusNotification === "function") {
        await addUserOrderStatusNotification({
          user_id: out.user_id,
          order_id,
          status: "CANCELLED",
          reason,
        });
      }
    } catch (e) {
      console.error("[cancelOrderByUser notify user failed]", {
        order_id,
        user_id: out.user_id,
        err: e?.message,
      });
    }

    return res.json({
      success: true,
      message: "Your order has been cancelled successfully.",
      order_id,
      status: "CANCELLED",
    });
  } catch (err) {
    console.error("[cancelOrderByUser ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
}

async function markOrderDelivered(req, res) {
  const order_id = String(req.params.order_id || req.body?.order_id || "")
    .trim()
    .toUpperCase();
  const delivered_by = String(req.body?.delivered_by || "SYSTEM").trim();
  const reason = String(req.body?.reason || "").trim();

  if (!order_id) {
    return res
      .status(400)
      .json({ success: false, message: "order_id is required" });
  }

  const conn = await db.getConnection();
  try {
    if (typeof completeAndArchiveDeliveredOrder !== "function")
      throw new Error(
        "completeAndArchiveDeliveredOrder() pipeline not found/exported.",
      );

    const result =
      completeAndArchiveDeliveredOrder.length >= 3
        ? await completeAndArchiveDeliveredOrder(conn, order_id, {
            delivered_by,
            reason,
            capture_at: "DELIVERED",
          })
        : await completeAndArchiveDeliveredOrder(order_id, {
            delivered_by,
            reason,
            capture_at: "DELIVERED",
          });

    if (!result?.ok) {
      return res.status(400).json({
        success: false,
        message: result?.code || "Failed to mark delivered",
        data: result || null,
      });
    }
    // console.log("[DELIVERED RESULT.capture]", result?.capture);

    await safeNotifyWalletAndDelivery(conn, {
      order_id,
      user_id: result.user_id,
      capture: result.capture,
    });

    try {
      broadcastOrderStatusToMany({
        order_id,
        user_id: result.user_id,
        business_ids: result.business_ids || [],
        status: "DELIVERED",
      });
    } catch {}

    return res.json({
      success: true,
      message: "Order delivered successfully.",
      data: result,
    });
  } catch (e) {
    console.error("[markOrderDelivered]", e);
    return res.status(500).json({
      success: false,
      message: "Technical error while marking delivered.",
      error: e?.message,
    });
  } finally {
    conn.release();
  }
}

module.exports = {
  uploadOrderImages,
  createOrder,
  getOrders,
  getOrderById,
  getOrdersByBusinessId,
  getBusinessOrdersGroupedByUser,
  getOrdersForUser,
  updateOrder,
  updateOrderStatus,
  deleteOrder,
  getOrderStatusCountsByBusiness,
  cancelOrderByUser,
  markOrderDelivered,
};
