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
    if (payload.if_unavailable !== undefined && payload.if_unavailable !== null) {
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
      if_unavailable, // ⬅️ use raw value from client (or null)
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

    return res
      .status(201)
      .json({ order_id, message: "Order created successfully" });
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

/**
 * PATCH /orders/:order_id/status
 * Includes:
 * - unavailable item changes
 * - totals update
 * - capture
 * - notifications
 */
/**
 * PATCH/PUT /orders/:order_id/status
 * Status rules:
 * - Block user cancel after acceptance.
 * - On CONFIRMED:
 *    - apply unavailable item changes to order_items
 *    - update final totals in orders
 *    - capture wallet / platform fee
 *    - send notifications (order, unavailable items, wallet deduction)
 */
async function updateOrderStatus(req, res){
  try {
    const order_id = req.params.order_id;

    // Accept both snake_case and camelCase from frontend
    const {
      status,
      reason,
      final_total_amount,
      final_platform_fee,
      final_discount_amount,
      unavailable_changes,
      unavailableChanges,
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

    // Block late cancels
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
      // 1) Apply unavailable item changes (remove/replace items)
      if (
        changes &&
        (Array.isArray(changes.removed) || Array.isArray(changes.replaced))
      ) {
        console.log(
          "[APPLY UNAVAILABLE ITEM CHANGES]",
          order_id,
          JSON.stringify(changes)
        );
        try {
          await Order.applyUnavailableItemChanges(order_id, changes);
        } catch (e) {
          console.error("[APPLY UNAVAILABLE ITEM CHANGES FAILED]", {
            order_id,
            err: e?.message,
          });
          return res.status(500).json({
            message: "Failed to apply item changes for unavailable products.",
            error: e?.message || "Item change error",
          });
        }
      }

      // 2) Update final totals on orders (these are already recomputed by FE)
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
    }

    // 3) Update status (and optional reason)
    const affected = await Order.updateStatus(
      order_id,
      normalized,
      (reason ?? "").toString().trim()
    );
    if (!affected) {
      return res.status(404).json({ message: "Order not found" });
    }

    // 4) Businesses involved in this order
    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const business_ids = bizRows.map((r) => r.business_id);

    // 5) On CONFIRMED → capture funds / platform fee and prepare wallet info
    let captureInfo = null;
    if (normalized === "CONFIRMED") {
      try {
        if (payMethod === "WALLET") {
          captureInfo = await Order.captureOrderFunds(order_id);
        } else if (payMethod === "COD") {
          captureInfo = await Order.captureOrderCODFee(order_id);
        }
      } catch (e) {
        console.error("[CAPTURE FAILED]", order_id, e?.message);
        return res.status(500).json({
          message: "Order accepted, but wallet capture failed.",
          error: e?.message || "Capture error",
        });
      }
    }

    // 6) Broadcast status to user & businesses (websocket)
    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids,
      status: normalized,
    });

    // 7) Merchant notification on COMPLETED
    try {
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
    } catch (e) {
      console.error("[STATUS NOTIFY INSERT FAILED]", {
        order_id,
        status: normalized,
        err: e?.message,
      });
    }

    // 8) User-side order status notification (generic)
    try {
      await Order.addUserOrderStatusNotification({
        user_id,
        order_id,
        status: normalized,
        reason,
      });
    } catch (e) {
      console.error("[USER ORDER STATUS NOTIFY FAILED on status change]", {
        order_id,
        status: normalized,
        err: e?.message,
      });
    }

    // 9) If unavailable items changed, notify user about remove/replace + final amount
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
          "[USER ORDER UNAVAILABLE ITEMS NOTIFY FAILED on CONFIRMED]",
          {
            order_id,
            err: e?.message,
          }
        );
      }
    }

    // 🔟 Wallet deduction notification LAST (after all order-related notifications)
    try {
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
          platform_fee: captureInfo.platform_fee,
          method: payMethod,
        });
      }
    } catch (e) {
      console.error("[USER WALLET DEBIT NOTIFY FAILED]", {
        order_id,
        err: e?.message,
      });
    }

    return res.json({ message: "Order status updated successfully" });
  } catch (err) {
    console.error("[updateOrderStatus ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
};


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
