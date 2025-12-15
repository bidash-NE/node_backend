// controllers/orderControllers.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");

const ALLOWED_STATUSES = new Set([
  "PENDING",
  "DECLINED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED", // ✅ FINAL
  "CANCELLED",
]);

function buildPreview(items = [], total_amount) {
  const parts = items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.item_name}`);
  const more = items.length > 2 ? `, +${items.length - 2} more` : "";
  const totalStr = Number(total_amount ?? 0).toFixed(2);
  return `${parts.join(", ")}${more} · Total Nu ${totalStr}`;
}

/**
 * POST /orders
 */
async function createOrder(req, res) {
  try {
    const payload = req.body || {};
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (!payload.user_id)
      return res.status(400).json({ message: "Missing user_id" });

    // ✅ service_type validation
    const serviceType = String(payload.service_type || "")
      .trim()
      .toUpperCase();
    if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
      return res.status(400).json({
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    if (!items.length)
      return res.status(400).json({ message: "Missing items" });
    if (payload.total_amount == null)
      return res.status(400).json({ message: "Missing total_amount" });
    if (payload.discount_amount == null)
      return res.status(400).json({ message: "Missing discount_amount" });

    if (payload.delivery_fee == null)
      return res.status(400).json({ message: "Missing delivery_fee" });
    if (payload.platform_fee == null)
      return res.status(400).json({ message: "Missing platform_fee" });

    const deliveryFee = Number(payload.delivery_fee);
    const platformFee = Number(payload.platform_fee);

    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) {
      return res.status(400).json({ message: "Invalid delivery_fee" });
    }
    if (!Number.isFinite(platformFee) || platformFee < 0) {
      return res.status(400).json({ message: "Invalid platform_fee" });
    }

    let merchantDeliveryFee = null;
    if (
      payload.merchant_delivery_fee !== undefined &&
      payload.merchant_delivery_fee !== null
    ) {
      merchantDeliveryFee = Number(payload.merchant_delivery_fee);
      if (!Number.isFinite(merchantDeliveryFee) || merchantDeliveryFee < 0) {
        return res
          .status(400)
          .json({ message: "Invalid merchant_delivery_fee" });
      }
    } else {
      merchantDeliveryFee = null;
    }

    if (deliveryFee > 0 && merchantDeliveryFee > 0) {
      return res.status(400).json({
        message:
          "delivery_fee and merchant_delivery_fee cannot both be greater than 0.",
      });
    }

    const payMethod = String(payload.payment_method || "").toUpperCase();
    if (!payMethod || !["WALLET", "COD", "CARD"].includes(payMethod)) {
      return res
        .status(400)
        .json({ message: "Invalid or missing payment_method" });
    }

    const fulfillment = String(payload.fulfillment_type || "Delivery");
    if (fulfillment === "Delivery") {
      const addrObj = payload.delivery_address;
      const isObj =
        addrObj && typeof addrObj === "object" && !Array.isArray(addrObj);
      const addrStr = isObj
        ? String(addrObj.address || "").trim()
        : String(addrObj || "").trim();
      if (!addrStr) {
        return res
          .status(400)
          .json({ message: "delivery_address is required for Delivery" });
      }
    } else if (fulfillment === "Pickup") {
      payload.delivery_address = String(payload.delivery_address || "");
    }

    for (const [idx, it] of items.entries()) {
      for (const f of [
        "business_id",
        "menu_id",
        "item_name",
        "quantity",
        "price",
        "subtotal",
      ]) {
        if (it[f] == null || it[f] === "") {
          return res.status(400).json({ message: `Item[${idx}] missing ${f}` });
        }
      }
    }

    let if_unavailable = null;
    if (
      payload.if_unavailable !== undefined &&
      payload.if_unavailable !== null
    ) {
      if_unavailable = String(payload.if_unavailable);
    }

    // ================== Preflight wallet checks ==================
    if (payMethod === "WALLET") {
      const buyer = await Order.getBuyerWalletByUserId(payload.user_id);
      if (!buyer) {
        return res.status(400).json({
          code: "WALLET_NOT_FOUND",
          message:
            "The wallet does not exist for your account. Please try creating one. HAPPY SHOPPING!",
        });
      }

      const need = Number(payload.total_amount || 0);
      const have = Number(buyer.amount || 0);
      if (have < need) {
        return res.status(400).json({
          code: "INSUFFICIENT_BALANCE",
          message: `Insufficient wallet balance. Required Nu. ${need.toFixed(
            2
          )}, available Nu. ${have.toFixed(2)}.`,
        });
      }

      const admin = await Order.getAdminWallet();
      if (!admin) {
        return res.status(500).json({
          code: "ADMIN_WALLET_MISSING",
          message: "Admin wallet is not configured.",
        });
      }
    } else if (payMethod === "COD") {
      const buyer = await Order.getBuyerWalletByUserId(payload.user_id);
      if (!buyer) {
        return res.status(400).json({
          code: "WALLET_NOT_FOUND",
          message:
            "The wallet does not exist for your account. Please try creating one. HAPPY SHOPPING!",
        });
      }

      const userFee =
        platformFee > 0 ? Number((platformFee / 2).toFixed(2)) : 0;
      if (userFee > 0) {
        const have = Number(buyer.amount || 0);
        if (have < userFee) {
          return res.status(400).json({
            code: "INSUFFICIENT_BALANCE",
            message: `Insufficient wallet balance for platform fee. Required Nu. ${userFee.toFixed(
              2
            )}, available Nu. ${have.toFixed(2)}.`,
          });
        }
      }

      const admin = await Order.getAdminWallet();
      if (!admin) {
        return res.status(500).json({
          code: "ADMIN_WALLET_MISSING",
          message: "Admin wallet is not configured.",
        });
      }
    }

    if (
      payload.delivery_address &&
      typeof payload.delivery_address === "object"
    ) {
      payload.delivery_address = JSON.stringify(payload.delivery_address);
    }

    payload.delivery_fee = deliveryFee;
    payload.platform_fee = platformFee;
    payload.merchant_delivery_fee = merchantDeliveryFee;

    const order_id = await Order.create({
      ...payload,
      service_type: serviceType,
      items,
      if_unavailable,
      status: (payload.status || "PENDING").toUpperCase(),
      fulfillment_type: fulfillment,
    });

    // Group by business for notifications
    const byBiz = new Map();
    for (const it of items) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const businessIds = Array.from(byBiz.keys());

    // Merchant notifications (order:create)
    for (const business_id of businessIds) {
      const its = byBiz.get(business_id) || [];
      const title = `New order #${order_id}`;
      const preview = buildPreview(its, payload.total_amount);

      try {
        await insertAndEmitNotification({
          business_id,
          user_id: payload.user_id,
          order_id,
          type: "order:create",
          title,
          body_preview: preview,
        });
      } catch (e) {
        console.error("[NOTIFY INSERT FAILED]", {
          order_id,
          business_id,
          err: e?.message,
        });
      }
    }

    const initialStatus = (payload.status || "PENDING").toUpperCase();

    broadcastOrderStatusToMany({
      order_id,
      user_id: payload.user_id,
      business_ids: businessIds,
      status: initialStatus,
    });

    try {
      await Order.addUserOrderStatusNotification({
        user_id: payload.user_id,
        order_id,
        status: initialStatus,
        reason: "",
      });
    } catch (e) {
      console.error("[USER ORDER STATUS NOTIFY FAILED on create]", {
        order_id,
        err: e?.message,
      });
    }

    return res.status(201).json({
      order_id,
      message:
        "Order created successfully. Note: 50% of the platform fee will be deducted from the merchant side.",
      totals: {
        total_amount: Number(payload.total_amount),
        discount_amount: Number(payload.discount_amount),
        delivery_fee: deliveryFee,
        platform_fee: platformFee,
        merchant_delivery_fee:
          merchantDeliveryFee !== null ? merchantDeliveryFee : null,
      },
      platform_fee_sharing: {
        user_share: 0.5,
        merchant_share: 0.5,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    const order_id = req.params.order_id;
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
    } = req.body || {};

    const changes = unavailable_changes || unavailableChanges || null;

    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalizedRaw = String(status).trim().toUpperCase();
    const normalized =
      normalizedRaw === "COMPLETED" ? "DELIVERED" : normalizedRaw;

    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(
          ", "
        )}`,
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

    /* =========================================================
       ✅ DELIVERED => archive to delivered_* and delete main rows
       ========================================================= */
    if (normalized === "DELIVERED") {
      const by =
        String(delivered_by || "SYSTEM")
          .trim()
          .toUpperCase() || "SYSTEM";
      const finalReason = String(reason || "").trim();

      const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
        delivered_by: by,
        reason: finalReason,
      });

      if (!out || !out.ok) {
        if (out?.code === "NOT_FOUND")
          return res.status(404).json({ message: "Order not found" });

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

      // broadcast AFTER delete using returned ids
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
       ✅ CANCELLED => archive+delete (existing logic kept)
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

      const finalReason = String(reason || "").trim();

      const out = await Order.cancelAndArchiveOrder(order_id, {
        cancelled_by: by,
        reason: finalReason,
        onlyIfStatus: null,
        expectedUserId: null,
      });

      if (!out || !out.ok) {
        if (out?.code === "NOT_FOUND")
          return res.status(404).json({ message: "Order not found" });

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

      if (estimated_minutes && !isNaN(Number(estimated_minutes))) {
        await updateEstimatedArrivalTime(order_id, estimated_minutes);
      }
    }

    /* ================= normal status update (non-cancel/non-delivered) ================= */
    const affected = await Order.updateStatus(
      order_id,
      normalized,
      (reason ?? "").toString().trim()
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
        reason,
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
