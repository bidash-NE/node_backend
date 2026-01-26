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
    let mergedBody = { ...body };
    if (typeof body.payload === "string") {
      const parsed = safeJsonParse(body.payload);
      if (parsed && typeof parsed === "object") {
        mergedBody = { ...mergedBody, ...parsed };
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

    // Fetch the scheduled orders by user
    const list = await getScheduledOrdersByUser(userId);

    if (!list.length) return res.json({ success: true, data: [] });

    // Extract unique business_ids from the orders
    const businessIds = [
      ...new Set(
        list
          .map((job) => job.business_id)
          .filter((bid) => bid != null && Number.isFinite(Number(bid)))
          .map((x) => Number(x)),
      ),
    ];

    // Fetch business details (logo and address) for each business_id
    let businessData = new Map();
    if (businessIds.length) {
      const placeholders = businessIds.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT business_id, business_logo, address
         FROM merchant_business_details
         WHERE business_id IN (${placeholders})`,
        businessIds,
      );
      businessData = new Map(rows.map((r) => [r.business_id, r]));
    }

    // Add item images to each item in the order based on menu_id
    const enrichedList = await Promise.all(
      list.map(async (job) => {
        const business = businessData.get(job.business_id) || {};
        const businessLogo = business.business_logo || null;
        const businessAddress = business.address || null;

        // Extract item images from the order_payload.items array
        const itemImagesPromises = job.order_payload.items.map(async (item) => {
          let itemImage = null;

          if (job.order_payload.service_type === "FOOD") {
            // Fetch item_image from food_menu table
            console.log(
              "Fetching item_image for food item menu_id:",
              item.menu_id,
            );
            const [foodMenuRow] = await db.query(
              `SELECT item_image FROM food_menu WHERE id = ? LIMIT 1`,
              [Number(item.menu_id)], // Ensure that menu_id is converted to a number
            );
            itemImage = foodMenuRow[0]?.item_image || null;
          } else if (job.order_payload.service_type === "MART") {
            // Fetch item_image from mart_menu table using LEFT JOIN for better data handling
            console.log(
              "Fetching item_image for mart item menu_id:",
              item.menu_id,
            );
            const [martMenuRow] = await db.query(
              `SELECT item_image FROM mart_menu WHERE id = ? LIMIT 1`,
              [Number(item.menu_id)], // Ensure that menu_id is converted to a number
            );
            console.log("Mart menu row:", martMenuRow);
            itemImage = martMenuRow[0]?.item_image || null;
          }

          item.item_image = itemImage; // Add item_image to the item object
          return item;
        });

        const enrichedItems = await Promise.all(itemImagesPromises);

        // console.log("Enriched Items After Update:", enrichedItems);

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
            items: enrichedItems, // Updated items with item_image
          },
        };
      }),
    );

    // console.log("Enriched List Before Response:", enrichedList);
    return res.json({ success: true, data: enrichedList });
  } catch (err) {
    console.error("getScheduledOrdersByUser error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

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

    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0),
    );

    const mapped = sorted.map((job) => {
      const uid = Number(job.user_id);
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

        order_payload: job.order_payload,
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
