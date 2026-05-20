// controllers/scheduledOrdersController.js
const db = require("../config/db");
const {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  getScheduledOrdersByBusiness,
  parseScheduledToEpochMs,
  epochToBhutanIso,
} = require("../models/scheduledOrderModel");

const ALLOWED_SERVICE_TYPES = new Set(["FOOD", "MART"]);

const MAX_PHOTOS = 6;

/**
 * ✅ Supports:
 * - JSON body (application/json)
 * - multipart/form-data (multer), where files come in req.files and body fields may be strings
 *
 * ✅ Enforces: max 6 photos total (uploaded files + any special_photos provided in body)
 *
 * NOTE:
 * - Make sure your route uses the upload middleware BEFORE this controller if using multipart:
 *   router.post("/scheduled-orders", uploadDeliveryPhotos, scheduleOrder);
 * - If you are only sending JSON with URIs (no files), this still works.
 */
exports.scheduleOrder = async (req, res) => {
  try {
    // ---------- helpers ----------
    const safeJsonParse = (v) => {
      if (v == null) return v;
      if (typeof v !== "string") return v;
      const s = v.trim();
      if (!s) return v;
      if (
        (s.startsWith("{") && s.endsWith("}")) ||
        (s.startsWith("[") && s.endsWith("]"))
      ) {
        try {
          return JSON.parse(s);
        } catch {
          return v;
        }
      }
      return v;
    };

    const asNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };

    const normalizeBool = (v) => {
      if (typeof v === "boolean") return v;
      const s = String(v || "")
        .trim()
        .toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no") return false;
      return v;
    };

    // ---------- raw body ----------
    const body = req.body || {};
    console.log("[scheduleOrder] content-type:", req.headers["content-type"]);
    console.log("[scheduleOrder] req.body keys:", Object.keys(body || {}));
    console.log(
      "[scheduleOrder] req.files keys:",
      Object.keys(req.files || {}),
    );

    // ✅ IMPORTANT: your Redis sample shows body.payload is a JSON string.
    // Merge it into body so special_photos doesn't get lost.
    // ✅ IMPORTANT: your Redis sample shows body.payload is a JSON string.
    let mergedBody = { ...body };
    if (typeof body.payload === "string") {
      const parsed = safeJsonParse(body.payload);
      if (parsed && typeof parsed === "object") {
        mergedBody = { ...mergedBody, ...parsed };

        // ✅ Also ensure items in parsed payload have business_name
        if (Array.isArray(parsed.items)) {
          mergedBody.items = parsed.items.map((item) => ({
            ...item,
            business_name: item.business_name || item.businessName || null,
            business_id: item.business_id || item.businessId || null,
          }));
        }
      }
    }

    // ---------- extract required fields ----------
    const user_id =
      mergedBody.user_id ?? mergedBody.userId ?? mergedBody.userid;
    const scheduled_at =
      mergedBody.scheduled_at ?? mergedBody.scheduledAt ?? mergedBody.scheduled;

    const userId = asNumber(user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id is required and must be a number.",
      });
    }

    if (!scheduled_at) {
      return res
        .status(400)
        .json({ success: false, message: "scheduled_at is required." });
    }

    // ✅ Bhutan-correct parsing (no timezone => treat as Bhutan local)
    const epochMs = parseScheduledToEpochMs(scheduled_at);
    if (!Number.isFinite(epochMs)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid scheduled_at format. Use ISO with +06:00 or without timezone for Bhutan local.",
      });
    }

    if (epochMs <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled time must be in the future.",
      });
    }

    // ---------- build orderPayload ----------
    const orderPayload = { ...mergedBody };

    delete orderPayload.user_id;
    delete orderPayload.userId;
    delete orderPayload.userid;

    delete orderPayload.scheduled_at;
    delete orderPayload.scheduledAt;
    delete orderPayload.scheduled;

    // Parse JSON-like string fields (common with multipart)
    orderPayload.items = safeJsonParse(orderPayload.items);
    orderPayload.totals = safeJsonParse(orderPayload.totals);
    orderPayload.delivery_address = safeJsonParse(
      orderPayload.delivery_address,
    );
    orderPayload.special_photos = safeJsonParse(orderPayload.special_photos);

    // Normalize types if strings
    if (orderPayload.priority != null)
      orderPayload.priority = normalizeBool(orderPayload.priority);

    if (orderPayload.delivery_lat != null)
      orderPayload.delivery_lat = asNumber(orderPayload.delivery_lat);

    if (orderPayload.delivery_lng != null)
      orderPayload.delivery_lng = asNumber(orderPayload.delivery_lng);

    if (orderPayload.business_id != null)
      orderPayload.business_id = asNumber(orderPayload.business_id);

    // ---------- validate items ----------
    if (!Array.isArray(orderPayload.items) || !orderPayload.items.length) {
      return res.status(400).json({
        success: false,
        message: "Order items are required.",
      });
    }

    // ---------- service_type validation ----------
    const serviceType = String(orderPayload.service_type || "")
      .trim()
      .toUpperCase();

    if (!serviceType || !ALLOWED_SERVICE_TYPES.has(serviceType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }
    orderPayload.service_type = serviceType;
    // ---------- FETCH ITEM IMAGES ----------
    if (Array.isArray(orderPayload.items) && orderPayload.items.length) {
      const serviceType = orderPayload.service_type; // Already validated as FOOD or MART
      const menuIds = orderPayload.items
        .map((item) => item.menu_id)
        .filter((id) => id != null && !isNaN(Number(id)));

      if (menuIds.length) {
        const tableName = serviceType === "FOOD" ? "food_menu" : "mart_menu";
        const placeholders = menuIds.map(() => "?").join(",");

        try {
          const [menuItems] = await db.query(
            `SELECT id, item_image FROM ${tableName} WHERE id IN (${placeholders})`,
            menuIds,
          );

          const imageMap = new Map();
          menuItems.forEach((item) => {
            imageMap.set(Number(item.id), item.item_image);
          });

          // Add item_image to each item
          orderPayload.items = orderPayload.items.map((item) => ({
            ...item,
            item_image: imageMap.get(Number(item.menu_id)) || null,
          }));

          console.log(
            `[scheduleOrder] Added images to ${orderPayload.items.length} items`,
          );
        } catch (err) {
          console.error("[scheduleOrder] Failed to fetch item images:", err);
          // Continue without images - don't block the order
        }
      }
    }
    // After: orderPayload.items = safeJsonParse(orderPayload.items);

    // ---------- ENSURE BUSINESS_NAME IN ITEMS ----------
    if (Array.isArray(orderPayload.items) && orderPayload.items.length) {
      // Get business_id from payload if not in items
      const globalBusinessId = orderPayload.business_id || null;

      orderPayload.items = orderPayload.items.map((item) => ({
        ...item,
        // Ensure business_id is set
        business_id: item.business_id || globalBusinessId,
        // Ensure business_name is set (prefer item's, then fetch from DB)
        business_name: item.business_name || null,
      }));

      // Fetch missing business names from database
      const missingBusinessIds = [
        ...new Set(
          orderPayload.items
            .filter((item) => !item.business_name && item.business_id)
            .map((item) => item.business_id),
        ),
      ];

      if (missingBusinessIds.length) {
        const placeholders = missingBusinessIds.map(() => "?").join(",");
        const [businesses] = await db.query(
          `SELECT business_id, business_name FROM merchant_business_details WHERE business_id IN (${placeholders})`,
          missingBusinessIds,
        );

        const businessNameMap = new Map();
        businesses.forEach((b) =>
          businessNameMap.set(b.business_id, b.business_name),
        );

        orderPayload.items = orderPayload.items.map((item) => ({
          ...item,
          business_name:
            item.business_name || businessNameMap.get(item.business_id) || null,
        }));
      }

      console.log(
        "[scheduleOrder] Items after business_name enrichment:",
        JSON.stringify(
          orderPayload.items.map((i) => ({
            business_id: i.business_id,
            business_name: i.business_name,
          })),
          null,
          2,
        ),
      );
    }
    // ---------- handle photos (URIs + uploaded files) ----------
    // 1) photos from body (JSON)
    let bodyUris = [];
    if (Array.isArray(orderPayload.special_photos)) {
      bodyUris = orderPayload.special_photos
        .map((u) => (u == null ? "" : String(u).trim()))
        .filter(Boolean);
    } else if (typeof orderPayload.special_photos === "string") {
      bodyUris = [orderPayload.special_photos.trim()].filter(Boolean);
    }

    // 2) uploaded files from multer (multipart)
    const files = []
      .concat(req.files?.delivery_photo || [])
      .concat(req.files?.delivery_photos || [])
      .concat(req.files?.image || [])
      .concat(req.files?.images || []);

    const uploadedUris = files
      .map((f) =>
        f?.filename ? `/uploads/order_delivery_photos/${f.filename}` : null,
      )
      .filter(Boolean);

    if (bodyUris.length + uploadedUris.length > MAX_PHOTOS) {
      return res.status(400).json({
        success: false,
        message: `Max ${MAX_PHOTOS} photos allowed.`,
      });
    }

    const merged = [...bodyUris, ...uploadedUris].slice(0, MAX_PHOTOS);

    // keep array form
    orderPayload.special_photos = merged;

    // ✅ IMPORTANT: your orders table column is delivery_photo_url (VARCHAR 500)
    // Option A (safe): store ONLY first photo to avoid truncation
    orderPayload.delivery_photo_url = merged[0] || null;

    // Option B (if you change column to TEXT): store JSON string
    // orderPayload.delivery_photo_url = merged.length ? JSON.stringify(merged) : null;

    // ---------- save ----------
    const saved = await addScheduledOrder(scheduled_at, orderPayload, userId);

    return res.json({
      success: true,
      message: "Order scheduled successfully.",
      job_id: saved.job_id,
      scheduled_at_utc: saved.scheduled_at,
      scheduled_at_local: saved.scheduled_at_local,
      service_type: saved.order_payload?.service_type || serviceType,
      photo_count: merged.length,
      photos: merged,
    });
  } catch (err) {
    console.error("scheduleOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

exports.listScheduledOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id parameter." });
    }

    const list = await getScheduledOrdersByUser(userId);
    if (!list.length) return res.json({ success: true, data: [] });

    // -------- business enrichment (logo + address) --------
    const businessIds = [
      ...new Set(
        list
          .map((job) => job.business_id)
          .filter((bid) => bid != null && Number.isFinite(Number(bid)))
          .map((x) => Number(x)),
      ),
    ];

    let businessData = new Map();
    if (businessIds.length) {
      const placeholders = businessIds.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT business_id, business_logo, address
           FROM merchant_business_details
          WHERE business_id IN (${placeholders})`,
        businessIds,
      );
      businessData = new Map(rows.map((r) => [Number(r.business_id), r]));
    }

    // -------- collect menu ids by service type (bulk fetch) --------
    const foodMenuIds = new Set();
    const martMenuIds = new Set();

    for (const job of list) {
      const serviceType = String(job?.order_payload?.service_type || "")
        .trim()
        .toUpperCase();

      const items = job?.order_payload?.items;
      if (!Array.isArray(items)) continue;

      for (const it of items) {
        const mid = Number(it?.menu_id);
        if (!Number.isFinite(mid) || mid <= 0) continue;

        if (serviceType === "FOOD") foodMenuIds.add(mid);
        else if (serviceType === "MART") martMenuIds.add(mid);
      }
    }

    const foodImageById = new Map();
    const martImageById = new Map();

    if (foodMenuIds.size) {
      const ids = [...foodMenuIds];
      const placeholders = ids.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT id, item_image
           FROM food_menu
          WHERE id IN (${placeholders})`,
        ids,
      );
      rows.forEach((r) =>
        foodImageById.set(Number(r.id), r.item_image || null),
      );
    }

    if (martMenuIds.size) {
      const ids = [...martMenuIds];
      const placeholders = ids.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT id, item_image
           FROM mart_menu
          WHERE id IN (${placeholders})`,
        ids,
      );
      rows.forEach((r) =>
        martImageById.set(Number(r.id), r.item_image || null),
      );
    }

    // -------- build response --------
    const enriched = list.map((job) => {
      const business = businessData.get(Number(job.business_id)) || {};
      const businessLogo = business.business_logo || null;
      const businessAddress = business.address || null;

      const serviceType = String(job?.order_payload?.service_type || "")
        .trim()
        .toUpperCase();

      const items = Array.isArray(job?.order_payload?.items)
        ? job.order_payload.items
        : [];

      const enrichedItems = items.map((it) => {
        const mid = Number(it?.menu_id);
        let itemImage = null;

        if (Number.isFinite(mid) && mid > 0) {
          if (serviceType === "FOOD")
            itemImage = foodImageById.get(mid) || null;
          else if (serviceType === "MART")
            itemImage = martImageById.get(mid) || null;
        }

        return { ...it, item_image: itemImage };
      });

      const itemImages = enrichedItems.map((it) => it.item_image || null);

      // ✅ extract status info
      const status = job?.order_payload?.status || "PENDING";
      const rejectionReason = job?.order_payload?.rejection_reason || null;
      const rejectedAt = job?.order_payload?.rejected_at || null;
      const acceptedAt = job?.order_payload?.accepted_at || null;

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        business_id: job.business_id ?? null,
        business_logo: businessLogo,
        business_address: businessAddress,

        scheduled_at_utc: job.scheduled_at ?? null,
        scheduled_at_local:
          job.scheduled_at_local ??
          (Number.isFinite(job.scheduled_epoch_ms)
            ? epochToBhutanIso(job.scheduled_epoch_ms)
            : null),

        created_at_utc: job.created_at ?? null,

        order_payload: {
          ...job.order_payload,

          // ✅ explicitly include status fields
          status,
          rejection_reason: rejectionReason,
          rejected_at: rejectedAt,
          accepted_at: acceptedAt,

          items: enrichedItems,
          item_images: itemImages,
        },
      };
    });

    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("listScheduledOrders error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

// controllers/scheduledOrdersController.js
// ✅ Updated: listScheduledOrdersByBusiness
// - Adds item_image per item (from food_menu or mart_menu based on service_type)
// - Adds order_payload.item_images as list (same order as items)

exports.listScheduledOrdersByBusiness = async (req, res) => {
  try {
    const businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId) || businessId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid businessId parameter.",
      });
    }

    const list = await getScheduledOrdersByBusiness(businessId);
    if (!list.length) return res.json({ success: true, data: [] });

    // -------- users enrichment (name) --------
    const userIds = [
      ...new Set(
        list
          .map((j) => j.user_id)
          .filter((uid) => uid != null && Number.isFinite(Number(uid)))
          .map((x) => Number(x)),
      ),
    ];

    let userNameById = new Map();
    if (userIds.length) {
      const placeholders = userIds.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT user_id, user_name FROM users WHERE user_id IN (${placeholders})`,
        userIds,
      );
      userNameById = new Map(rows.map((r) => [Number(r.user_id), r.user_name]));
    }

    // -------- collect menu ids --------
    const foodMenuIds = new Set();
    const martMenuIds = new Set();

    for (const job of list) {
      const serviceType = String(job?.order_payload?.service_type || "")
        .trim()
        .toUpperCase();

      const items = job?.order_payload?.items;
      if (!Array.isArray(items)) continue;

      for (const it of items) {
        const mid = Number(it?.menu_id);
        if (!Number.isFinite(mid) || mid <= 0) continue;

        if (serviceType === "FOOD") foodMenuIds.add(mid);
        else if (serviceType === "MART") martMenuIds.add(mid);
      }
    }

    const foodImageById = new Map();
    const martImageById = new Map();

    if (foodMenuIds.size) {
      const ids = [...foodMenuIds];
      const placeholders = ids.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT id, item_image FROM food_menu WHERE id IN (${placeholders})`,
        ids,
      );
      rows.forEach((r) =>
        foodImageById.set(Number(r.id), r.item_image || null),
      );
    }

    if (martMenuIds.size) {
      const ids = [...martMenuIds];
      const placeholders = ids.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT id, item_image FROM mart_menu WHERE id IN (${placeholders})`,
        ids,
      );
      rows.forEach((r) =>
        martImageById.set(Number(r.id), r.item_image || null),
      );
    }

    // -------- sort + map --------
    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0),
    );

    const mapped = sorted.map((job) => {
      const uid = Number(job.user_id);

      const serviceType = String(job?.order_payload?.service_type || "")
        .trim()
        .toUpperCase();

      const items = Array.isArray(job?.order_payload?.items)
        ? job.order_payload.items
        : [];

      const enrichedItems = items.map((it) => {
        const mid = Number(it?.menu_id);
        let itemImage = null;

        if (Number.isFinite(mid) && mid > 0) {
          if (serviceType === "FOOD")
            itemImage = foodImageById.get(mid) || null;
          else if (serviceType === "MART")
            itemImage = martImageById.get(mid) || null;
        }

        return { ...it, item_image: itemImage };
      });

      const itemImages = enrichedItems.map((it) => it.item_image || null);

      // ✅ status extraction
      const status = job?.order_payload?.status || "PENDING";
      const rejectionReason = job?.order_payload?.rejection_reason || null;
      const rejectedAt = job?.order_payload?.rejected_at || null;
      const acceptedAt = job?.order_payload?.accepted_at || null;

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        name: userNameById.get(uid) || null,
        business_id: job.business_id ?? null,

        scheduled_at_utc: job.scheduled_at ?? null,
        scheduled_at_local:
          job.scheduled_at_local ??
          (Number.isFinite(job.scheduled_epoch_ms)
            ? epochToBhutanIso(job.scheduled_epoch_ms)
            : null),

        created_at_utc: job.created_at ?? null,

        order_payload: {
          ...job.order_payload,

          // ✅ added fields
          status,
          rejection_reason: rejectionReason,
          rejected_at: rejectedAt,
          accepted_at: acceptedAt,

          items: enrichedItems,
          item_images: itemImages,
        },
      };
    });

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("listScheduledOrdersByBusiness error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

// controllers/scheduledOrdersController.js
// ✅ Replace your existing exports.cancelScheduledOrder with this one

exports.cancelScheduledOrder = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const jobId = String(req.params.jobId || "").trim();

    if (!Number.isFinite(userId) || userId <= 0 || !jobId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id or jobId.",
      });
    }

    const redis = require("../config/redis");
    const { buildJobKey } = require("../models/scheduledOrderModel"); // ✅ only this

    const jobKey = buildJobKey(jobId);
    const raw = await redis.get(jobKey);

    if (!raw) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found.",
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        success: false,
        message: "Corrupted scheduled order data.",
      });
    }

    if (Number(data.user_id) !== userId) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to cancel this scheduled order.",
      });
    }

    let epochMs = Number(data.scheduled_epoch_ms);
    if (!Number.isFinite(epochMs)) {
      const fromLocal = data.scheduled_at_local || null;
      const fromUtc = data.scheduled_at || null;
      epochMs = parseScheduledToEpochMs(fromLocal || fromUtc); // ✅ uses top import
    }

    if (!Number.isFinite(epochMs)) {
      return res.status(500).json({
        success: false,
        message: "Unable to determine scheduled time for this order.",
      });
    }

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const diffMs = epochMs - Date.now();

    if (diffMs <= ONE_HOUR_MS) {
      const minsLeft = Math.max(0, Math.floor(diffMs / (60 * 1000)));
      return res.status(400).json({
        success: false,
        code: "CANCEL_WINDOW_CLOSED",
        message:
          "Scheduled order cannot be cancelled before 1 hour of the scheduled time.",
        minutes_remaining: minsLeft,
      });
    }

    const ok = await cancelScheduledOrderForUser(jobId, userId);
    if (!ok) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found for this user.",
      });
    }

    return res.json({
      success: true,
      message: "Scheduled order cancelled.",
      job_id: jobId,
    });
  } catch (err) {
    console.error("cancelScheduledOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

// In controllers/scheduledOrdersController.js
exports.updateScheduledOrderStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { status, reason } = req.body;

    if (!jobId || !["ACCEPTED", "REJECTED"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid jobId or status (ACCEPTED / REJECTED required)",
      });
    }

    if (status === "REJECTED" && (!reason || !reason.trim())) {
      return res.status(400).json({
        success: false,
        message: "Reason is required when rejecting a scheduled order",
      });
    }

    const redis = require("../config/redis");
    const { buildJobKey, ZSET_KEY } = require("../models/scheduledOrderModel");

    const {
      sendUserNotification,
    } = require("../services/expoNotificationService");

    const jobKey = buildJobKey(jobId);
    const raw = await redis.get(jobKey);

    if (!raw) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found",
      });
    }

    let data = JSON.parse(raw);

    // Prevent double action
    if (data.order_payload?.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Order already ${data.order_payload.status}`,
      });
    }

    const userId = data.user_id;

    if (status === "REJECTED") {
      const cleanReason = reason.trim();

      // Update status
      data.order_payload.status = "REJECTED";
      data.order_payload.rejection_reason = cleanReason;
      data.order_payload.rejected_at = new Date().toISOString();
      data.updated_at = new Date().toISOString();

      // ✅ IMPORTANT: DO NOT remove from ZSET
      // Keep it in ZSET so cleanup service can find it
      // await redis.zrem(ZSET_KEY, jobId);  // ❌ DON'T DO THIS

      // ✅ Save the updated data
      await redis.set(jobKey, JSON.stringify(data));

      // ✅ DO NOT set short TTL (let cleanup service handle it)
      // await redis.expire(jobKey, 1800);  // ❌ DON'T DO THIS

      // Send notification
      await sendUserNotification({
        user_id: userId,
        title: "Order Rejected",
        body: `Your scheduled order has been rejected. Reason: ${cleanReason}. This order will be automatically removed after 30 minutes.`,
      });

      return res.json({
        success: true,
        message: "Scheduled order rejected. Will be removed after 30 minutes.",
        job_id: jobId,
        status: "REJECTED",
        reason: cleanReason,
        visible_until_minutes: 30,
      });
    }

    if (status === "ACCEPTED") {
      data.order_payload.status = "ACCEPTED";
      data.order_payload.accepted_at = new Date().toISOString();
      data.updated_at = new Date().toISOString();

      await redis.set(jobKey, JSON.stringify(data));

      await sendUserNotification({
        user_id: userId,
        title: "Order Accepted",
        body: `Your scheduled order has been accepted and will be processed at the scheduled time.`,
      });

      return res.json({
        success: true,
        message: `Scheduled order ${status.toLowerCase()}`,
        job_id: jobId,
        status,
      });
    }
  } catch (err) {
    console.error("updateScheduledOrderStatus error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
