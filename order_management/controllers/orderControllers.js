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
  "COMPLETED",
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

    // ---- Base validations ----
    if (!payload.user_id)
      return res.status(400).json({ message: "Missing user_id" });
    if (!items.length)
      return res.status(400).json({ message: "Missing items" });
    if (payload.total_amount == null)
      return res.status(400).json({ message: "Missing total_amount" });
    if (payload.discount_amount == null)
      return res.status(400).json({ message: "Missing discount_amount" });

    const payMethod = String(payload.payment_method || "").toUpperCase();
    if (!payMethod || !["WALLET", "COD", "CARD"].includes(payMethod)) {
      return res
        .status(400)
        .json({ message: "Invalid or missing payment_method" });
    }

    // ---- Fulfillment-specific validation ----
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

    // ---- Validate item fields we persist (no math) ----
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
      if (it.delivery_fee != null && Number.isNaN(Number(it.delivery_fee))) {
        return res
          .status(400)
          .json({ message: `Item[${idx}] invalid delivery_fee` });
      }
    }

    // ---- if_unavailable: just take whatever client sends, no defaults ----
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
      const fee = Number(payload.platform_fee ?? 0);
      if (fee > 0) {
        const have = Number(buyer.amount || 0);
        if (have < fee) {
          return res.status(400).json({
            code: "INSUFFICIENT_BALANCE",
            message: `Insufficient wallet balance for platform fee. Required Nu. ${fee.toFixed(
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

    // Persist exactly what FE sent (ensure delivery_address object is stringified)
    if (
      payload.delivery_address &&
      typeof payload.delivery_address === "object"
    ) {
      payload.delivery_address = JSON.stringify(payload.delivery_address);
    }

    const order_id = await Order.create({
      ...payload,
      if_unavailable, // use raw value from client (or null)
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
 */
async function getOrdersForUser(req, res) {
  try {
    const data = await Order.findByUserIdForApp(req.params.user_id);
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

    // Use UTC so server timezone doesn't matter, then convert to Bhutan time (+06)
    const now = new Date();

    // Start of window: now + merchant estimate
    const startDate = new Date(now.getTime() + mins * 60 * 1000);
    // End of window: start + 30 minutes
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

    const BHUTAN_OFFSET_HOURS = 6;

    const toBhutanParts = (d) => {
      // convert UTC → Bhutan local
      let hour24 = (d.getUTCHours() + BHUTAN_OFFSET_HOURS) % 24;
      const minute = d.getUTCMinutes();
      const meridiem = hour24 >= 12 ? "PM" : "AM";
      const hour12 = hour24 % 12 || 12; // 0 → 12
      return { hour12, minute, meridiem };
    };

    const s = toBhutanParts(startDate);
    const e = toBhutanParts(endDate);

    const sStr = `${s.hour12}:${String(s.minute).padStart(2, "0")}`;
    const eStr = `${e.hour12}:${String(e.minute).padStart(2, "0")}`;

    // If both sides are same AM/PM, show it once at the end.
    // If it crosses noon/midnight, show both.
    let formattedRange;
    if (s.meridiem === e.meridiem) {
      formattedRange = `${sStr} - ${eStr} ${s.meridiem}`; // e.g. "1:15 - 1:45 PM"
    } else {
      formattedRange = `${sStr} ${s.meridiem} - ${eStr} ${e.meridiem}`; // e.g. "11:50 AM - 12:20 PM"
    }

    await db.query(
      `UPDATE orders SET estimated_arrivial_time = ? WHERE order_id = ?`,
      [formattedRange, order_id]
    );

    console.log(
      `✅ estimated_arrivial_time updated for ${order_id} → ${formattedRange} (start in ${mins} mins, +30 min window)`
    );
  } catch (err) {
    console.error("[updateEstimatedArrivalTime ERROR]", err.message);
  }
}

/**
 * PATCH/PUT /orders/:order_id/status
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
      unavailable_changes,
      unavailableChanges,
      estimated_minutes, // ⬅️ from merchant
    } = req.body || {};

    const changes = unavailable_changes || unavailableChanges || null;

    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalized = String(status).trim().toUpperCase();
    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(
          ", "
        )}`,
      });
    }

    // Get current order info
    const [[row]] = await db.query(
      `SELECT user_id, status AS current_status, payment_method
       FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!row) return res.status(404).json({ message: "Order not found" });

    const user_id = row.user_id;
    const current = String(row.current_status || "PENDING").toUpperCase();
    const payMethod = String(row.payment_method || "").toUpperCase();

    // Prevent late cancellations
    if (normalized === "CANCELLED") {
      const locked = new Set([
        "CONFIRMED",
        "PREPARING",
        "READY",
        "OUT_FOR_DELIVERY",
        "COMPLETED",
      ]);
      if (locked.has(current)) {
        return res.status(400).json({
          message:
            "Order cannot be cancelled after it has been accepted by the merchant.",
        });
      }
    }

    // ===================== CONFIRMED FLOW =====================
    if (normalized === "CONFIRMED") {
      // 💳 If payment is via WALLET, ensure ALL involved merchants have wallets
      if (payMethod === "WALLET") {
        const [merchantRows] = await db.query(
          `
          SELECT m.business_id, w.wallet_id
            FROM order_items oi
            JOIN merchant_business_details m ON m.business_id = oi.business_id
            LEFT JOIN wallets w ON w.user_id = m.user_id
           WHERE oi.order_id = ?
        `,
          [order_id]
        );

        if (!merchantRows.length) {
          return res.status(400).json({
            message:
              "The store’s wallet is not yet set up to receive this order. Please try again after the store completes their wallet setup. Thank you for your patience!",
          });
        }

        const merchantsWithoutWallet = merchantRows.filter((r) => !r.wallet_id);

        if (merchantsWithoutWallet.length > 0) {
          return res.status(400).json({
            message:
              "The store’s wallet is not yet set up to receive this order. Please try again after the store completes their wallet setup. Thank you for your patience!",
          });
        }
      }

      // 1️⃣ Apply unavailable item changes
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

      // 2️⃣ Update final totals
      const updatePayload = {};
      if (final_total_amount != null)
        updatePayload.total_amount = Number(final_total_amount);
      if (final_platform_fee != null)
        updatePayload.platform_fee = Number(final_platform_fee);
      if (final_discount_amount != null)
        updatePayload.discount_amount = Number(final_discount_amount);

      if (Object.keys(updatePayload).length) {
        await Order.update(order_id, updatePayload);
      }

      // 3️⃣ Handle estimated arrival minutes
      if (estimated_minutes && !isNaN(Number(estimated_minutes))) {
        await updateEstimatedArrivalTime(order_id, estimated_minutes);
      }
    }

    // 4️⃣ Update order status + reason
    const affected = await Order.updateStatus(
      order_id,
      normalized,
      (reason ?? "").toString().trim()
    );
    if (!affected) {
      return res.status(404).json({ message: "Order not found" });
    }

    // 5️⃣ Business IDs
    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const business_ids = bizRows.map((r) => r.business_id);

    // 6️⃣ Capture payment (if CONFIRMED)
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

    // 7️⃣ Broadcast status
    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids,
      status: normalized,
    });

    // 8️⃣ Completed order notifications
    if (normalized === "COMPLETED") {
      for (const business_id of business_ids) {
        await insertAndEmitNotification({
          business_id,
          user_id,
          order_id,
          type: "order:status",
          title: `Order #${order_id} COMPLETED`,
          body_preview: `Status changed to COMPLETED`,
        });
      }
    }

    // 9️⃣ Notify user of status
    await Order.addUserOrderStatusNotification({
      user_id,
      order_id,
      status: normalized,
      reason,
    });

    // 🔟 Notify unavailable item changes
    if (
      normalized === "CONFIRMED" &&
      changes &&
      (Array.isArray(changes.removed) || Array.isArray(changes.replaced))
    ) {
      await Order.addUserUnavailableItemNotification({
        user_id,
        order_id,
        changes,
        final_total_amount:
          final_total_amount != null ? Number(final_total_amount) : null,
      });
    }

    // 💬 Wallet deduction notification
    if (
      captureInfo &&
      captureInfo.captured &&
      !captureInfo.skipped &&
      !captureInfo.alreadyCaptured
    ) {
      await Order.addUserWalletDebitNotification({
        user_id: captureInfo.user_id,
        order_id,
        order_amount: captureInfo.order_amount,
        // if you later return platform_fee_user etc, you can adjust this
        platform_fee: captureInfo.platform_fee,
        method: payMethod,
      });
    }

    return res.json({
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
};
