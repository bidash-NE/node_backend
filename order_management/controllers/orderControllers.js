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

exports.createOrder = async (req, res) => {
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
      const addr = String(payload.delivery_address || "").trim();
      if (!addr) {
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

    // ================== NEW: Prefight wallet checks ==================
    // We check BEFORE creating the order, so user cannot place an order that will fail later.
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
      // Optional: verify admin wallet exists early
      const admin = await Order.getAdminWallet();
      if (!admin) {
        return res.status(500).json({
          code: "ADMIN_WALLET_MISSING",
          message: "Admin wallet is not configured.",
        });
      }
    } else if (payMethod === "COD") {
      // For COD, we still require buyer wallet to exist and have at least platform_fee.
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
    // ================== END preflight checks ==================

    // Persist exactly what FE sent
    const order_id = await Order.create({
      ...payload,
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

    // Broadcast status to user & businesses
    broadcastOrderStatusToMany({
      order_id,
      user_id: payload.user_id,
      business_ids: businessIds,
      status: (payload.status || "PENDING").toUpperCase(),
    });

    return res
      .status(201)
      .json({ order_id, message: "Order created successfully" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ----- Everything below remains the same -----
exports.getOrders = async (_req, res) => {
  try {
    const orders = await Order.findAll();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const grouped = await Order.findByOrderIdGrouped(req.params.order_id);
    if (!grouped.length)
      return res.status(404).json({ message: "Order not found" });
    res.json({ success: true, data: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getOrdersByBusinessId = async (req, res) => {
  try {
    const items = await Order.findByBusinessId(req.params.business_id);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getBusinessOrdersGroupedByUser = async (req, res) => {
  try {
    const data = await Order.findByBusinessGroupedByUser(
      req.params.business_id
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getOrdersForUser = async (req, res) => {
  try {
    const data = await Order.findByUserIdForApp(req.params.user_id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.updateOrder = async (req, res) => {
  try {
    const affectedRows = await Order.update(req.params.order_id, req.body);
    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Status rules:
 * - Block user cancel after acceptance.
 * - On CONFIRMED: capture funds (WALLET) or fee (COD).
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const order_id = req.params.order_id;
    const { status, reason } = req.body || {};
    if (!status) return res.status(400).json({ message: "Status is required" });

    const normalized = String(status).trim().toUpperCase();
    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(
          ", "
        )}`,
      });
    }

    const [[row]] = await db.query(
      `SELECT user_id, status AS current_status, payment_method
         FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!row) return res.status(404).json({ message: "Order not found" });

    const user_id = row.user_id;
    const current = String(row.current_status || "PENDING").toUpperCase();
    const payMethod = String(row.payment_method || "").toUpperCase();

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

    if (normalized === "CONFIRMED") {
      try {
        if (payMethod === "WALLET") {
          await Order.captureOrderFunds(order_id);
        } else if (payMethod === "COD") {
          await Order.captureOrderCODFee(order_id);
        }
      } catch (e) {
        console.error("[CAPTURE FAILED]", order_id, e?.message);
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

    res.json({ message: "Order status updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteOrder = async (req, res) => {
  try {
    const affectedRows = await Order.delete(req.params.order_id);
    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
