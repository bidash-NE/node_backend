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

function buildPreview(items = [], orderLevelFees = {}) {
  const parts = items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.item_name}`);
  const more = items.length > 2 ? `, +${items.length - 2} more` : "";

  // items subtotal
  const itemsSubtotal = items.reduce(
    (a, it) => a + Number(it.subtotal || 0),
    0
  );

  // If you switch to order-level fees, read from orderLevelFees. Otherwise, keep summing per-line.
  const platform =
    orderLevelFees.platform_fee != null
      ? Number(orderLevelFees.platform_fee)
      : items.reduce((a, it) => a + Number(it.platform_fee || 0), 0);

  const delivery =
    orderLevelFees.delivery_fee != null
      ? Number(orderLevelFees.delivery_fee)
      : items.reduce((a, it) => a + Number(it.delivery_fee || 0), 0);

  const discount = Number(orderLevelFees.discount_amount || 0);
  const total = (itemsSubtotal + platform + delivery - discount).toFixed(2);

  return `${parts.join(", ")}${more} · Total Nu ${total}`;
}

exports.createOrder = async (req, res) => {
  try {
    const payload = req.body || {};
    const { user_id, items = [], delivery_address } = payload;

    if (
      !user_id ||
      !Array.isArray(items) ||
      !items.length ||
      !delivery_address
    ) {
      return res
        .status(400)
        .json({ message: "Missing user_id, items or delivery_address" });
    }

    // 1) Persist order (transaction inside model). Only returns if COMMIT succeeded.
    const order_id = await Order.create({
      ...payload,
      status: "PENDING",
    });

    // 2) Group items by business_id (1 notification per merchant)
    const byBiz = new Map();
    for (const it of items) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const merchantIds = Array.from(byBiz.keys());

    // 3) Insert durable notifications; emit only if merchant is online (handled in realtime)
    for (const merchant_id of merchantIds) {
      // ensure merchant exists (adjust if schema differs)
      const [[biz]] = await db.query(
        `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
        [merchant_id]
      );
      if (!biz) continue;

      const its = byBiz.get(merchant_id);
      const preview = buildPreview(its, {
        platform_fee: orderData.platform_fee, // if using Option A
        delivery_fee: orderData.delivery_fee,
        discount_amount: orderData.discount_amount,
      });
      const title = `New order #${order_id}`;

      insertAndEmitNotification({
        merchant_id,
        user_id,
        order_id,
        title,
        body_preview: preview,
        type: "order:create",
      }).catch((e) => console.warn("notify error:", e.message));
    }

    // 4) Return success (no reliance on socket success)
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
    const { status, reason } = req.body || {}; // ⬅️ stop relying on req.body.user_id

    if (!status) return res.status(400).json({ message: "Status is required" });

    const normalized = String(status).trim().toUpperCase();
    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(
          ", "
        )}`,
      });
    }

    const reasonStr = (reason ?? "").toString().trim();
    if (!reasonStr) {
      return res
        .status(400)
        .json({ message: "Reason is required for status change" });
    }

    // Update status in DB
    const affected = await Order.updateStatus(order_id, normalized, reasonStr);
    if (!affected) return res.status(404).json({ message: "Order not found" });

    // ⬇️ NEW: get user_id from orders (do NOT trust client body)
    const [[orderRow]] = await db.query(
      `SELECT user_id FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id]
    );
    const userIdToNotify = orderRow ? orderRow.user_id : null;

    // merchants linked to this order (unchanged)
    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const merchant_ids = bizRows.map((r) => r.business_id);

    // Broadcast
    broadcastOrderStatusToMany({
      order_id,
      user_id: userIdToNotify, // ⬅️ reliable user_id
      merchant_ids,
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
