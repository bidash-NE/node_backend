// controllers/orderControllers.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");
const { MAX_PHOTOS } = require("../middleware/uploadDeliveryPhoto");

/* ===================== NEW: uploads support ===================== */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

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

// Public URL prefix for returning uploaded images
const PUBLIC_UPLOAD_BASE =
  (process.env.PUBLIC_UPLOAD_BASE || "/uploads").replace(/\/+$/, "") + "/";

function toPublicUploadUrl(absPath) {
  // absPath is something like: <root>/uploads/orders/ORD-xxx/filename.jpg
  // return: /uploads/orders/ORD-xxx/filename.jpg (or configured PUBLIC_UPLOAD_BASE)
  const rel = path.relative(UPLOAD_ROOT, absPath).split(path.sep).join("/");
  return `${PUBLIC_UPLOAD_BASE}${rel}`;
}

// Multer storage: store into /uploads/orders/<order_id>/... (order_id from req.body.order_id or req.generated_order_id)
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
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 4 * 1024 * 1024), // 4MB default
    files: Number(process.env.UPLOAD_MAX_FILES || 10),
  },
});

// ✅ Export this to use in your routes for multipart/form-data
// Fields supported:
//  - order_images (multiple)
//  - item_image_0, item_image_1 ... (per item index)
//  - item_image_<menu_id> (per menu_id)
const uploadOrderImages = upload.any();

/* ===================== status rules ===================== */
const ALLOWED_STATUSES = new Set([
  "ASSIGNED",
  "PENDING",
  "DECLINED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED", // ✅ FINAL
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

  // tolerate variations
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

/* ===================== NEW: json normalization helpers ===================== */

// Accept BOTH old and new item shapes
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
    _index: idx, // keep for mapping uploads
  };
}

function mapUploadedFilesToPayload(req, order_id, items) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return { order_images: [], item_images: new Map() };

  // If multer stored into TMP but we now have a real order_id, move them
  const tmpDir = path.join(ORDERS_UPLOAD_DIR, "TMP");
  const finalDir = path.join(ORDERS_UPLOAD_DIR, order_id);
  ensureDir(finalDir);

  const orderImages = [];
  const itemImages = new Map(); // key: index OR menu_id, value: url

  for (const f of files) {
    // f.path exists for diskStorage
    const field = String(f.fieldname || "");
    let absPath = f.path;

    // Move from TMP into final order folder if needed
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

    // item_image_0, item_image_1 ...
    const idxMatch = field.match(/^item_image_(\d+)$/);
    if (idxMatch) {
      itemImages.set(Number(idxMatch[1]), url);
      continue;
    }

    // item_image_<menu_id>
    const midMatch = field.match(/^item_image_(\d{1,10})$/);
    if (midMatch) {
      itemImages.set(String(midMatch[1]), url);
      continue;
    }

    // fallback: try originalname mapping "menuId-123.png"
    const name = String(f.originalname || "");
    const om = name.match(/(\d{1,10})/);
    if (om) itemImages.set(String(om[1]), url);
  }

  // Apply mapped item images to normalized items
  for (const it of items) {
    const idx = Number(it._index);
    const menuId = it.menu_id != null ? String(it.menu_id) : null;

    if (itemImages.has(idx)) it.item_image = itemImages.get(idx);
    else if (menuId && itemImages.has(menuId))
      it.item_image = itemImages.get(menuId);
  }

  return { order_images: orderImages, item_images: itemImages };
}

// ---------- helpers for multipart + JSON ----------
function parseMaybeJSON(v) {
  if (v == null) return v;
  if (typeof v !== "string") return v;

  const s = v.trim();
  if (!s) return v;

  // only attempt JSON if it looks like JSON
  if (!(s.startsWith("{") || s.startsWith("["))) return v;

  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/**
 * Supports:
 *  - application/json body
 *  - multipart/form-data where:
 *      req.body.payload = JSON string
 *      or nested fields are JSON strings
 */
function getOrderInput(req) {
  let body = req.body || {};

  // Prefer `payload` JSON if present
  if (typeof body.payload === "string") {
    const p = parseMaybeJSON(body.payload);
    if (p && typeof p === "object") body = p;
  }

  // Parse nested JSON strings if any
  body.items = parseMaybeJSON(body.items);
  body.delivery_address = parseMaybeJSON(body.delivery_address);

  // Normalize numeric/bool types (multipart sends strings)
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

  if (body.priority != null) {
    body.priority = String(body.priority).toLowerCase() === "true";
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

/**
 * POST /orders
 * router.post("/orders", uploadOrderImages, createOrder)
 */

// IMPORTANT: import these at top of file (near other requires)
// const { toWebPaths, MAX_PHOTOS } = require("../middleware/uploadDeliveryPhoto");

async function createOrder(req, res) {
  const safeUnlink = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  };

  // ✅ cleanup helper: removes original TMP path + moved path (if moved)
  const cleanupUploadedFiles = (order_id = null) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const tmpPrefix = path.join(ORDERS_UPLOAD_DIR, "TMP") + path.sep;

      for (const f of files) {
        const p = String(f?.path || "");
        if (!p) continue;

        // If file was originally uploaded into TMP, it was moved to /orders/<order_id>/
        if (order_id && p.startsWith(tmpPrefix)) {
          const moved = path.join(
            ORDERS_UPLOAD_DIR,
            String(order_id),
            path.basename(p),
          );
          safeUnlink(moved);
        } else {
          // Otherwise it already lives in correct place -> delete directly
          safeUnlink(p);
        }
      }
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
    if (!payMethod || !["WALLET", "COD", "CARD"].includes(payMethod)) {
      cleanupUploadedFiles();
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or missing payment_method" });
    }

    // ✅ normalize item shapes
    const normalizedItems = itemsRaw.map((it, idx) =>
      normalizeItemShape(it, idx),
    );

    // ✅ stable order_id
    const order_id = String(payload.order_id || Order.peekNewOrderId())
      .trim()
      .toUpperCase();
    payload.order_id = order_id;

    // ✅ IMPORTANT: move multer TMP uploads into /orders/<order_id>/ and get urls
    // (uses your existing helper)
    const moved = mapUploadedFilesToPayload(req, order_id, normalizedItems);
    const uploadedPhotoUrls = Array.isArray(moved.order_images)
      ? moved.order_images
      : [];

    // ✅ AddressDetails mapping
    payload.delivery_floor_unit =
      payload.delivery_floor_unit ??
      payload.floor_unit ??
      payload.floorUnit ??
      payload.unit_floor ??
      null;

    payload.delivery_instruction_note =
      payload.delivery_instruction_note ??
      payload.special_instructions ??
      payload.delivery_note ??
      payload.instruction_note ??
      null;

    payload.delivery_special_mode = normalizeSpecialMode(
      payload.delivery_special_mode ??
        payload.special_mode ??
        payload.special_instruction_mode ??
        payload.dropoff_or_meetup,
    );

    const fulfillment = normalizeFulfillment(payload.fulfillment_type);

    if (fulfillment === "Delivery") {
      const addrObj = payload.delivery_address;

      const addrStr =
        addrObj && typeof addrObj === "object"
          ? String(
              addrObj.address || addrObj.addr || addrObj.full_address || "",
            ).trim()
          : String(addrObj || "").trim();

      if (!addrStr) {
        cleanupUploadedFiles(order_id);
        return res.status(400).json({
          ok: false,
          message: "delivery_address is required for Delivery",
        });
      }
    }

    if (
      payload.delivery_address &&
      typeof payload.delivery_address === "object"
    ) {
      payload.delivery_address = JSON.stringify(payload.delivery_address);
    }

    /* =========================
       ✅ DELIVERY PHOTOS MERGE
       ========================= */
    const bodyList = Array.isArray(payload.delivery_photo_urls)
      ? payload.delivery_photo_urls
      : Array.isArray(payload.special_photos)
        ? payload.special_photos
        : [];

    const bodySingle = payload.delivery_photo_url
      ? [payload.delivery_photo_url]
      : [];

    const allPhotos = dedupeStrings([
      ...bodyList,
      ...bodySingle,
      ...uploadedPhotoUrls,
    ]);

    if (allPhotos.length > MAX_PHOTOS) {
      cleanupUploadedFiles(order_id);
      return res.status(400).json({
        ok: false,
        message: `Maximum ${MAX_PHOTOS} photos are allowed.`,
        received: allPhotos.length,
      });
    }

    payload.delivery_photo_urls = allPhotos;
    payload.delivery_photo_url = allPhotos.length ? allPhotos[0] : null;

    const status = String(payload.status || "PENDING")
      .trim()
      .toUpperCase();

    const created_id = await Order.create({
      ...payload,
      service_type: serviceType,
      payment_method: payMethod,
      fulfillment_type: fulfillment,
      status,
      items: normalizedItems,
    });

    // Notifications grouped by business
    const byBiz = new Map();
    for (const it of normalizedItems) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const businessIds = Array.from(byBiz.keys());

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

/**
 * GET /orders
 */
async function getOrders(_req, res) {
  try {
    const orders = await Order.findAll();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /orders/:order_id
 */
async function getOrderById(req, res) {
  try {
    const grouped = await Order.findByOrderIdGrouped(req.params.order_id);
    if (!grouped.length)
      return res.status(404).json({ message: "Order not found" });
    res.json({ success: true, data: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /orders/business/:business_id
 */
async function getOrdersByBusinessId(req, res) {
  try {
    const items = await Order.findByBusinessId(req.params.business_id);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /orders/business/:business_id/grouped
 */
async function getBusinessOrdersGroupedByUser(req, res) {
  try {
    const data = await Order.findByBusinessGroupedByUser(
      req.params.business_id,
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /users/:user_id/orders
 * Optional query:
 *   ?service_type=FOOD|MART
 */
async function getOrdersForUser(req, res) {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id" });
    }

    let data = await Order.findByUserIdForApp(userId);

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

/**
 * PUT /orders/:order_id
 */
async function updateOrder(req, res) {
  try {
    const affectedRows = await Order.update(req.params.order_id, req.body);
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
      let hour24 = (d.getUTCHours() + BHUTAN_OFFSET_HOURS) % 24;
      const minute = d.getUTCMinutes();
      const meridiem = hour24 >= 12 ? "PM" : "AM";
      const hour12 = hour24 % 12 || 12;
      return { hour12, minute, meridiem };
    };

    const s = toBhutanParts(startDate);
    const e = toBhutanParts(endDate);

    const sStr = `${s.hour12}:${String(s.minute).padStart(2, "0")}`;
    const eStr = `${e.hour12}:${String(e.minute).padStart(2, "0")}`;

    let formattedRange;
    if (s.meridiem === e.meridiem) {
      formattedRange = `${sStr} - ${eStr} ${s.meridiem}`;
    } else {
      formattedRange = `${sStr} ${s.meridiem} - ${eStr} ${e.meridiem}`;
    }

    await db.query(
      `UPDATE orders SET estimated_arrivial_time = ? WHERE order_id = ?`,
      [formattedRange, order_id],
    );
  } catch (err) {
    console.error("[updateEstimatedArrivalTime ERROR]", err.message);
  }
}

/**
 * PATCH/PUT /orders/:order_id/status
 * ✅ FIXED: For CONFIRMED => do wallet capture BEFORE setting status=CONFIRMED
 * ✅ FINAL: For DELIVERED => archive+delete via completeAndArchiveDeliveredOrder()
 * ✅ FINAL: For CANCELLED => archive+delete
 * ✅ Backward compatible: if status=COMPLETED, treat as DELIVERED
 */
async function updateOrderStatus(req, res) {
  try {
    const order_id = String(req.params.order_id || "").trim();

    const body = req.body || {};
    const {
      status,
      reason,

      final_total_amount,
      final_platform_fee,
      final_discount_amount,
      final_delivery_fee,
      final_merchant_delivery_fee,

      unavailable_changes,
      unavailableChanges,

      estimated_minutes,

      cancelled_by,
      delivered_by,
    } = body;

    // ✅ STRICT: status must be provided
    if (typeof status !== "string" || !status.trim()) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalizedRaw = status.trim().toUpperCase();
    const normalized =
      normalizedRaw === "COMPLETED" ? "DELIVERED" : normalizedRaw;

    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(
          ", ",
        )}`,
        received: normalizedRaw,
        normalized,
      });
    }

    // ✅ helper that prevents "" -> 0 and NaN writes
    const numOrUndef = (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "string" && v.trim() === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // lock current order row first
    const [[row]] = await db.query(
      `SELECT user_id, status AS current_status, payment_method
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id],
    );

    if (!row) return res.status(404).json({ message: "Order not found" });

    const user_id = Number(row.user_id);
    const current = String(row.current_status || "PENDING").toUpperCase();
    const payMethod = String(row.payment_method || "").toUpperCase();

    const changes = unavailable_changes || unavailableChanges || null;
    const finalReason = String(reason || "").trim();

    // ✅ NEW: capture timing toggle (default DELIVERED)
    const CAPTURE_AT = String(process.env.CAPTURE_AT || "DELIVERED")
      .trim()
      .toUpperCase();

    /* =========================================================
       ✅ DELIVERED => capture + merchant_earnings + archive+delete (atomic in model)
       ========================================================= */
    if (normalized === "DELIVERED") {
      const by =
        String(delivered_by || "SYSTEM")
          .trim()
          .toUpperCase() || "SYSTEM";

      const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
        delivered_by: by,
        reason: finalReason,
        capture_at: CAPTURE_AT,
      });

      if (!out || !out.ok) {
        if (out?.code === "NOT_FOUND") {
          return res.status(404).json({ message: "Order not found" });
        }
        if (out?.code === "SKIPPED") {
          return res.status(400).json({
            message: "Unable to mark this order as delivered.",
            current_status: out.current_status,
          });
        }
        if (out?.code === "CAPTURE_FAILED") {
          return res.status(500).json({
            success: false,
            message: "Unable to deliver order. Capture failed.",
            error: out.error || "Capture error",
          });
        }
        return res
          .status(400)
          .json({ message: "Unable to mark this order as delivered." });
      }

      const business_ids = Array.isArray(out.business_ids)
        ? out.business_ids
        : [];

      broadcastOrderStatusToMany({
        order_id,
        user_id: out.user_id,
        business_ids,
        status: "DELIVERED",
      });

      for (const business_id of business_ids) {
        try {
          await insertAndEmitNotification({
            business_id,
            user_id: out.user_id,
            order_id,
            type: "order:status",
            title: `Order #${order_id} DELIVERED`,
            body_preview: finalReason || "Order delivered.",
          });
        } catch (e) {
          console.error(
            "[updateOrderStatus DELIVERED notify merchant failed]",
            {
              order_id,
              business_id,
              err: e?.message,
            },
          );
        }
      }

      try {
        await Order.addUserOrderStatusNotification({
          user_id: out.user_id,
          order_id,
          status: "DELIVERED",
          reason: finalReason,
        });
      } catch (e) {
        console.error("[updateOrderStatus DELIVERED notify user failed]", {
          order_id,
          user_id: out.user_id,
          err: e?.message,
        });
      }

      // ✅ NEW: if capture happened on DELIVERED, notify wallet debit now
      try {
        const cap = out?.capture || null;
        if (
          cap &&
          cap.captured &&
          !cap.skipped &&
          !cap.alreadyCaptured &&
          (cap.payment_method === "WALLET" || cap.payment_method === "COD")
        ) {
          await Order.addUserWalletDebitNotification({
            user_id: cap.user_id,
            order_id,
            order_amount: cap.order_amount || 0,
            platform_fee: cap.platform_fee_user || 0,
            method: cap.payment_method,
          });
        }
      } catch (e) {
        console.error("[DELIVERED wallet debit notify failed]", e?.message);
      }

      return res.json({
        success: true,
        message: "Order delivered and archived successfully.",
        order_id,
        status: "DELIVERED",
        points_awarded:
          out.points && out.points.awarded ? out.points.points_awarded : null,
        capture: out.capture || null,
        earnings: out.earnings || null,
      });
    }

    /* =========================================================
       ✅ CANCELLED => archive+delete
       ========================================================= */
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

      const by =
        String(cancelled_by || "SYSTEM")
          .trim()
          .toUpperCase() || "SYSTEM";

      const out = await Order.cancelAndArchiveOrder(order_id, {
        cancelled_by: by,
        reason: finalReason,
        onlyIfStatus: null,
        expectedUserId: null,
      });

      if (!out || !out.ok) {
        if (out?.code === "NOT_FOUND") {
          return res.status(404).json({ message: "Order not found" });
        }
        if (out?.code === "SKIPPED") {
          return res.status(400).json({
            message: "Unable to cancel this order.",
            current_status: out.current_status,
          });
        }
        return res
          .status(400)
          .json({ message: "Unable to cancel this order." });
      }

      const business_ids = Array.isArray(out.business_ids)
        ? out.business_ids
        : [];

      broadcastOrderStatusToMany({
        order_id,
        user_id: out.user_id,
        business_ids,
        status: "CANCELLED",
      });

      for (const business_id of business_ids) {
        try {
          await insertAndEmitNotification({
            business_id,
            user_id: out.user_id,
            order_id,
            type: "order:status",
            title: `Order #${order_id} CANCELLED`,
            body_preview: finalReason || "Order cancelled.",
          });
        } catch (e) {
          console.error(
            "[updateOrderStatus CANCELLED notify merchant failed]",
            {
              order_id,
              business_id,
              err: e?.message,
            },
          );
        }
      }

      try {
        await Order.addUserOrderStatusNotification({
          user_id: out.user_id,
          order_id,
          status: "CANCELLED",
          reason: finalReason,
        });
      } catch (e) {
        console.error("[updateOrderStatus CANCELLED notify user failed]", {
          order_id,
          user_id: out.user_id,
          err: e?.message,
        });
      }

      return res.json({
        success: true,
        message: "Order cancelled successfully.",
        order_id,
        status: "CANCELLED",
      });
    }

    /* ================= Existing protections ================= */
    if (current === "CANCELLED" && normalized === "CONFIRMED") {
      return res.status(400).json({
        success: false,
        message:
          "This order has already been cancelled and cannot be accepted.",
      });
    }

    /* =========================================================
       ✅ CONFIRMED (accept) logic
       - apply changes (optional)
       - update totals ONLY if numbers were provided
       - ETA (estimated_minutes)
       - ✅ CAPTURE only if CAPTURE_AT != DELIVERED (backward compatible)
       ========================================================= */
    let captureInfo = null;

    if (normalized === "CONFIRMED") {
      if (
        changes &&
        (Array.isArray(changes.removed) || Array.isArray(changes.replaced))
      ) {
        try {
          await Order.applyUnavailableItemChanges(order_id, changes);
        } catch (e) {
          return res.status(500).json({
            message: "Failed to apply item changes for unavailable products.",
            error: e?.message || "Item change error",
          });
        }
      }

      console.log("[CONFIRM] incoming finals", {
        order_id,
        payMethod,
        final_total_amount,
        final_platform_fee,
        final_delivery_fee,
        final_discount_amount,
        final_merchant_delivery_fee,
        estimated_minutes,
      });

      const updatePayload = {};

      const nTotal = numOrUndef(final_total_amount);
      if (nTotal !== undefined) updatePayload.total_amount = nTotal;

      const nPlatform = numOrUndef(final_platform_fee);
      if (nPlatform !== undefined) updatePayload.platform_fee = nPlatform;

      const nDelivery = numOrUndef(final_delivery_fee);
      if (nDelivery !== undefined) updatePayload.delivery_fee = nDelivery;

      const nMerchDelivery = numOrUndef(final_merchant_delivery_fee);
      if (nMerchDelivery !== undefined)
        updatePayload.merchant_delivery_fee = nMerchDelivery;

      const nDiscount = numOrUndef(final_discount_amount);
      if (nDiscount !== undefined) updatePayload.discount_amount = nDiscount;

      if (Object.keys(updatePayload).length) {
        await Order.update(order_id, updatePayload);
      }

      const etaMins = numOrUndef(estimated_minutes);
      if (etaMins !== undefined && etaMins > 0) {
        await updateEstimatedArrivalTime(order_id, etaMins);
      }

      // ✅ only capture here if you are NOT using delivered-capture mode
      if (CAPTURE_AT !== "DELIVERED") {
        try {
          if (payMethod === "WALLET") {
            captureInfo = await Order.captureOrderFunds(order_id);
          } else if (payMethod === "COD") {
            captureInfo = await Order.captureOrderCODFee(order_id);
          }
        } catch (e) {
          console.error("[CAPTURE FAILED]", {
            order_id,
            payMethod,
            err: e?.message,
          });
          return res.status(500).json({
            success: false,
            message: "Unable to accept order. Capture failed.",
            error: e?.message || "Capture error",
            order_id,
            payment_method: payMethod,
          });
        }
      }
    }

    /* ================= normal status update (non-cancel/non-delivered) ================= */
    const affected = await Order.updateStatus(
      order_id,
      normalized,
      finalReason,
    );
    if (!affected) return res.status(404).json({ message: "Order not found" });

    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id],
    );
    const business_ids = bizRows.map((r) => r.business_id);

    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids,
      status: normalized,
    });

    try {
      await Order.addUserOrderStatusNotification({
        user_id,
        order_id,
        status: normalized,
        reason: finalReason,
      });
    } catch (e) {
      console.error("[updateOrderStatus notify user failed]", {
        order_id,
        user_id,
        err: e?.message,
      });
    }

    if (
      normalized === "CONFIRMED" &&
      changes &&
      (Array.isArray(changes.removed) || Array.isArray(changes.replaced))
    ) {
      try {
        const nFinalTotal = numOrUndef(final_total_amount);
        await Order.addUserUnavailableItemNotification({
          user_id,
          order_id,
          changes,
          final_total_amount: nFinalTotal !== undefined ? nFinalTotal : null,
        });
      } catch (e) {
        console.error(
          "[updateOrderStatus unavailable notify failed]",
          e?.message,
        );
      }
    }

    if (
      captureInfo &&
      captureInfo.captured &&
      !captureInfo.skipped &&
      !captureInfo.alreadyCaptured
    ) {
      try {
        await Order.addUserWalletDebitNotification({
          user_id: captureInfo.user_id,
          order_id,
          order_amount: captureInfo.order_amount,
          platform_fee: captureInfo.platform_fee_user,
          method: payMethod,
        });
      } catch (e) {
        console.error("[wallet debit notify failed]", e?.message);
      }
    }

    const etaApplied =
      normalized === "CONFIRMED" &&
      numOrUndef(estimated_minutes) !== undefined &&
      numOrUndef(estimated_minutes) > 0
        ? `${Number(estimated_minutes)} min`
        : null;

    return res.json({
      success: true,
      message: "Order status updated successfully",
      estimated_arrivial_time_applied: etaApplied,
    });
  } catch (err) {
    console.error("[updateOrderStatus ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /orders/:order_id
 */
async function deleteOrder(req, res) {
  try {
    const affectedRows = await Order.delete(req.params.order_id);
    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /orders/business/:business_id/status-counts
 */
async function getOrderStatusCountsByBusiness(req, res) {
  try {
    const business_id = Number(req.params.business_id);
    if (!Number.isFinite(business_id) || business_id <= 0) {
      return res.status(400).json({ message: "Invalid business_id" });
    }

    const counts = await Order.getOrderStatusCountsByBusiness(business_id);
    return res.json(counts);
  } catch (err) {
    console.error("[getOrderStatusCountsByBusiness]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * PATCH /users/:user_id/orders/:order_id/cancel
 * ✅ FINAL: cancel + archive + delete from main tables
 */
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

    const out = await Order.cancelAndArchiveOrder(order_id, {
      cancelled_by: "USER",
      reason,
      onlyIfStatus: "PENDING",
      expectedUserId: user_id_param,
    });

    if (!out.ok) {
      if (out.code === "NOT_FOUND")
        return res.status(404).json({ message: "Order not found" });

      if (out.code === "FORBIDDEN")
        return res
          .status(403)
          .json({ message: "You are not allowed to cancel this order." });

      if (out.code === "SKIPPED") {
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

    for (const business_id of out.business_ids) {
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
      await Order.addUserOrderStatusNotification({
        user_id: out.user_id,
        order_id,
        status: "CANCELLED",
        reason,
      });
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

module.exports = {
  // ✅ NEW: use this middleware in routes before createOrder
  // Example: router.post("/orders", uploadOrderImages, createOrder)
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
};
