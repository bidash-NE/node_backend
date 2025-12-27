// controllers/orderControllers.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");

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
function safeJsonParse(val) {
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

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
function safeJsonParse(val) {
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

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

function isDataUrlImage(str) {
  return (
    typeof str === "string" &&
    /^data:image\/(png|jpeg|jpg|webp);base64,/.test(str)
  );
}

function writeBase64ImageToOrderDir(order_id, dataUrl, prefix = "img") {
  const m = String(dataUrl).match(
    /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/
  );
  if (!m) return null;
  const ext = m[1] === "jpeg" ? ".jpg" : m[1] === "jpg" ? ".jpg" : `.${m[1]}`;
  const base64 = m[2];
  const buf = Buffer.from(base64, "base64");
  if (!buf?.length) return null;

  const dir = path.join(ORDERS_UPLOAD_DIR, order_id);
  ensureDir(dir);

  const name = `${prefix}_${Date.now()}_${crypto
    .randomBytes(6)
    .toString("hex")}${ext}`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf);
  return toPublicUploadUrl(abs);
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

/**
 * POST /orders
 * router.post("/orders", uploadOrderImages, createOrder)
 */

async function createOrder(req, res) {
  // small helper: delete orphan uploads on validation fail
  const safeUnlink = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  };

  try {
    // ✅ support JSON and multipart(payload)
    let payload = req.body || {};
    if (typeof payload.payload === "string") {
      payload = safeJsonParse(payload.payload) || payload;
    }

    // items may be stringified
    let itemsRaw = payload.items;
    if (typeof itemsRaw === "string") itemsRaw = safeJsonParse(itemsRaw);
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];

    // basic validation
    if (!payload.user_id) {
      (Array.isArray(req.files) ? req.files : []).forEach((f) =>
        safeUnlink(f?.path)
      );
      return res.status(400).json({ message: "Missing user_id" });
    }

    const serviceType = normalizeServiceType(payload.service_type);
    if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
      (Array.isArray(req.files) ? req.files : []).forEach((f) =>
        safeUnlink(f?.path)
      );
      return res.status(400).json({
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    const payMethod = normalizePaymentMethod(payload.payment_method);
    if (!payMethod || !["WALLET", "COD", "CARD"].includes(payMethod)) {
      (Array.isArray(req.files) ? req.files : []).forEach((f) =>
        safeUnlink(f?.path)
      );
      return res
        .status(400)
        .json({ message: "Invalid or missing payment_method" });
    }

    if (!items.length) {
      (Array.isArray(req.files) ? req.files : []).forEach((f) =>
        safeUnlink(f?.path)
      );
      return res.status(400).json({ message: "Missing items" });
    }

    // ✅ normalize item shapes (so item_image mapping works)
    const normalizedItems = items.map((it, idx) => normalizeItemShape(it, idx));

    // ✅ stable order_id (IMPORTANT)
    const order_id = String(payload.order_id || Order.peekNewOrderId())
      .trim()
      .toUpperCase();
    payload.order_id = order_id;

    // ✅ map AddressDetails fields
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
        payload.dropoff_or_meetup
    );

    const fulfillment = normalizeFulfillment(payload.fulfillment_type);

    // delivery_address required for Delivery
    if (fulfillment === "Delivery") {
      const addrObj = payload.delivery_address;
      const addrStr =
        addrObj && typeof addrObj === "object"
          ? String(
              addrObj.address || addrObj.addr || addrObj.full_address || ""
            ).trim()
          : String(addrObj || "").trim();

      if (!addrStr) {
        (Array.isArray(req.files) ? req.files : []).forEach((f) =>
          safeUnlink(f?.path)
        );
        return res
          .status(400)
          .json({ message: "delivery_address is required for Delivery" });
      }
    }

    // ✅ stringify delivery_address object for DB
    if (
      payload.delivery_address &&
      typeof payload.delivery_address === "object"
    ) {
      payload.delivery_address = JSON.stringify(payload.delivery_address);
    }

    /* =========================================================
       ✅ UPLOADS + BODY PHOTOS (IMPORTANT FIX)
       - DO NOT overwrite body delivery_photo_url when no uploads
       - Always build a LIST: delivery_photo_urls
       ========================================================= */

    // 1) uploaded files -> urls
    const { order_images } = mapUploadedFilesToPayload(
      req,
      order_id,
      normalizedItems
    );

    // also accept delivery_photo/image as "photos"
    const files = Array.isArray(req.files) ? req.files : [];
    const extraPhotoFields = new Set([
      "delivery_photo",
      "delivery_photos",
      "image",
    ]);
    const extraPhotos = [];

    for (const f of files) {
      if (!f?.path) continue;
      if (!extraPhotoFields.has(String(f.fieldname || ""))) continue;
      extraPhotos.push(toPublicUploadUrl(f.path));
    }

    const uploadedPhotos = Array.from(
      new Set([...(order_images || []), ...(extraPhotos || [])])
    );

    // 2) body photos (JSON direct order / scheduled order)
    const bodyPhotosRaw = Array.isArray(payload.delivery_photo_urls)
      ? payload.delivery_photo_urls
      : Array.isArray(payload.special_photos)
      ? payload.special_photos
      : null;

    const bodyPhotos = Array.isArray(bodyPhotosRaw)
      ? bodyPhotosRaw
          .map((x) => (x == null ? "" : String(x).trim()))
          .filter(Boolean)
      : [];

    const bodySingle = payload.delivery_photo_url
      ? [String(payload.delivery_photo_url).trim()].filter(Boolean)
      : [];

    // 3) merge + dedupe
    const allPhotos = Array.from(
      new Set([...bodyPhotos, ...bodySingle, ...uploadedPhotos])
    );

    // ✅ enforce max 6
    if (allPhotos.length > 6) {
      files.forEach((f) => safeUnlink(f?.path));
      return res.status(400).json({
        ok: false,
        message: "Maximum 6 photos are allowed.",
        received: allPhotos.length,
      });
    }

    // ✅ store both
    payload.delivery_photo_urls = allPhotos; // list (even if 1)
    payload.delivery_photo_url = allPhotos.length
      ? allPhotos[0]
      : payload.delivery_photo_url || null; // keep body value if no uploads

    /* ===================== CREATE ORDER ===================== */
    const created_id = await Order.create({
      ...payload,
      service_type: serviceType,
      payment_method: payMethod,
      fulfillment_type: fulfillment,
      status: String(payload.status || "PENDING").toUpperCase(),
      items: normalizedItems,
    });

    // Notifications (same idea)
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
      status: String(payload.status || "PENDING").toUpperCase(),
    });

    return res.status(201).json({
      ok: true,
      order_id: created_id,

      // ✅ return photos to app
      delivery_photo_urls: payload.delivery_photo_urls || [],
      delivery_photo_url: payload.delivery_photo_url || null,

      delivery_floor_unit: payload.delivery_floor_unit || null,
      delivery_instruction_note: payload.delivery_instruction_note || null,
      delivery_special_mode: payload.delivery_special_mode || null,
    });
  } catch (err) {
    console.error("[createOrder ERROR]", err);
    // cleanup uploads on crash
    (Array.isArray(req.files) ? req.files : []).forEach((f) =>
      safeUnlink(f?.path)
    );
    return res.status(500).json({ ok: false, error: err.message });
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
      req.params.business_id
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
      [formattedRange, order_id]
    );
  } catch (err) {
    console.error("[updateEstimatedArrivalTime ERROR]", err.message);
  }
}

/**
 * PATCH/PUT /orders/:order_id/status
 * ✅ FINAL FIX: If status=DELIVERED => archive+delete via completeAndArchiveDeliveredOrder()
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
      cancelled_by, // optional
      delivered_by, // optional
    } = body;

    // ✅ STRICT: status must be provided and must match the allowed set (after normalization)
    if (typeof status !== "string" || !status.trim()) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalizedRaw = status.trim().toUpperCase();
    const normalized =
      normalizedRaw === "COMPLETED" ? "DELIVERED" : normalizedRaw;

    // ✅ STRICT: DO NOT allow anything outside ALLOWED_STATUSES
    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(
          ", "
        )}`,
        received: normalizedRaw,
        normalized,
      });
    }

    // lock current order row first
    const [[row]] = await db.query(
      `SELECT user_id, status AS current_status, payment_method
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id]
    );

    if (!row) return res.status(404).json({ message: "Order not found" });

    const user_id = Number(row.user_id);
    const current = String(row.current_status || "PENDING").toUpperCase();
    const payMethod = String(row.payment_method || "").toUpperCase();

    const changes = unavailable_changes || unavailableChanges || null;
    const finalReason = String(reason || "").trim();

    /* =========================================================
       ✅ DELIVERED => archive to delivered_* and delete main rows
       ========================================================= */
    if (normalized === "DELIVERED") {
      const by =
        String(delivered_by || "SYSTEM")
          .trim()
          .toUpperCase() || "SYSTEM";

      const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
        delivered_by: by,
        reason: finalReason,
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
            }
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

      return res.json({
        success: true,
        message: "Order delivered and archived successfully.",
        order_id,
        status: "DELIVERED",
        points_awarded:
          out.points && out.points.awarded ? out.points.points_awarded : null,
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
            }
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

    /* ================= CONFIRMED logic ================= */
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

      const updatePayload = {};
      if (final_total_amount != null)
        updatePayload.total_amount = Number(final_total_amount);
      if (final_platform_fee != null)
        updatePayload.platform_fee = Number(final_platform_fee);
      if (final_delivery_fee != null)
        updatePayload.delivery_fee = Number(final_delivery_fee);
      if (final_merchant_delivery_fee != null)
        updatePayload.merchant_delivery_fee = Number(
          final_merchant_delivery_fee
        );
      if (final_discount_amount != null)
        updatePayload.discount_amount = Number(final_discount_amount);

      if (Object.keys(updatePayload).length) {
        await Order.update(order_id, updatePayload);
      }

      if (
        estimated_minutes != null &&
        Number.isFinite(Number(estimated_minutes))
      ) {
        await updateEstimatedArrivalTime(order_id, estimated_minutes);
      }
    }

    /* ================= normal status update (non-cancel/non-delivered) ================= */
    const affected = await Order.updateStatus(
      order_id,
      normalized,
      finalReason
    );
    if (!affected) return res.status(404).json({ message: "Order not found" });

    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const business_ids = bizRows.map((r) => r.business_id);

    let captureInfo = null;
    if (normalized === "CONFIRMED") {
      try {
        if (payMethod === "WALLET") {
          captureInfo = await Order.captureOrderFunds(order_id);
        } else if (payMethod === "COD") {
          captureInfo = await Order.captureOrderCODFee(order_id);
        }
      } catch (e) {
        return res.status(500).json({
          message: "Order accepted, but wallet capture failed.",
          error: e?.message || "Capture error",
        });
      }
    }

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
        await Order.addUserUnavailableItemNotification({
          user_id,
          order_id,
          changes,
          final_total_amount:
            final_total_amount != null ? Number(final_total_amount) : null,
        });
      } catch (e) {
        console.error(
          "[updateOrderStatus unavailable notify failed]",
          e?.message
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

    return res.json({
      success: true,
      message: "Order status updated successfully",
      estimated_arrivial_time_applied:
        normalized === "CONFIRMED" && estimated_minutes
          ? `${estimated_minutes} min`
          : null,
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
