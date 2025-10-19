// controllers/orderControllers.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");

const ALLOWED_STATUSES = new Set([
  "PENDING",
  "REJECTED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "CANCELLED",
]);

/** Build a short toast line for merchants (no math here). */
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

    // ---- Base validations (no backend math) ----
    if (!payload.user_id) {
      return res.status(400).json({ message: "Missing user_id" });
    }
    if (!items.length) {
      return res.status(400).json({ message: "Missing items" });
    }
    if (payload.total_amount == null) {
      return res.status(400).json({ message: "Missing total_amount" });
    }
    if (payload.discount_amount == null) {
      return res.status(400).json({ message: "Missing discount_amount" });
    }

    // ---- Fulfillment-specific validation for delivery_address ----
    const fulfillment = String(payload.fulfillment_type || "Delivery");
    if (fulfillment === "Delivery") {
      const addr = String(payload.delivery_address || "").trim();
      if (!addr) {
        return res
          .status(400)
          .json({ message: "delivery_address is required for Delivery" });
      }
    } else if (fulfillment === "Pickup") {
      // ensure non-null (column is NOT NULL); store empty string for pickup
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

    // 1) Persist EXACTLY what FE sent (uppercase status only)
    const order_id = await Order.create({
      ...payload,
      status: (payload.status || "PENDING").toUpperCase(),
      fulfillment_type: fulfillment, // normalize usage
    });

    // 2) Group items by business_id for notifications
    const byBiz = new Map();
    for (const it of items) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const businessIds = Array.from(byBiz.keys());

    // 3) Insert+emit notifications that include EXACT total_amount from FE
    for (const business_id of businessIds) {
      const its = byBiz.get(business_id) || [];
      const title = `New order #${order_id}`;
      const preview = buildPreview(its, payload.total_amount);

      try {
        await insertAndEmitNotification({
          business_id, // ✅ store key
          user_id: payload.user_id, // buyer
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

    // 4) Broadcast status to user & businesses
    broadcastOrderStatusToMany({
      order_id,
      user_id: payload.user_id,
      business_ids: businessIds, // ✅ emit to business rooms
      status: (payload.status || "PENDING").toUpperCase(),
    });

    return res
      .status(201)
      .json({ order_id, message: "Order created successfully" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

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

    // Fetch user_id (for emitting to user room)
    const [[orderRow]] = await db.query(
      `SELECT user_id FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    if (!orderRow) return res.status(404).json({ message: "Order not found" });

    const user_id = orderRow.user_id;

    // Reason optional; store trimmed or NULL
    const reasonStr = (reason ?? "").toString().trim() || null;

    const affected = await Order.updateStatus(order_id, normalized, reasonStr);
    if (!affected) return res.status(404).json({ message: "Order not found" });

    // Get affected businesses for this order
    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const business_ids = bizRows.map((r) => r.business_id);

    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids, // ✅ business scoped
      status: normalized,
    });

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
