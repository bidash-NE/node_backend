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

function buildPreview(items = [], totals = null) {
  const parts = items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.item_name}`);
  const more = items.length > 2 ? `, +${items.length - 2} more` : "";

  if (totals && totals.total_amount != null) {
    const t = Number(totals.total_amount).toFixed(2);
    return `${parts.join(", ")}${more} · Total Nu ${t}`;
  }

  const itemsSubtotal = items.reduce(
    (a, it) => a + Number(it.subtotal || 0),
    0
  );
  return `${parts.join(", ")}${more} · Subtotal Nu ${itemsSubtotal.toFixed(2)}`;
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

    // 1) Persist order immediately (always saved)
    const order_id = await Order.create({
      ...payload,
      status: "PENDING",
    });

    // Compute totals for preview/socket payload (uses the same logic as the model)
    const totals = Order.computeTotals(payload);

    // 2) Group items by business_id (one notification per merchant)
    const byBiz = new Map();
    for (const it of items) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const merchantIds = Array.from(byBiz.keys());

    // 3) Insert notification row(s) first, then emit (+ include totals)
    for (const merchant_id of merchantIds) {
      // ensure merchant exists
      const [[biz]] = await db.query(
        `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
        [merchant_id]
      );
      if (!biz) continue;

      const its = byBiz.get(merchant_id);
      const title = `New order #${order_id}`;
      const preview = buildPreview(its, totals);

      await insertAndEmitNotification({
        merchant_id,
        user_id,
        order_id,
        title,
        body_preview: preview,
        type: "order:create",
        totals, // ⬅ add totals to socket payload
      }).catch((e) => console.warn("notify error:", e.message));
    }

    // 4) Broadcast initial status PENDING to user + all merchant rooms
    broadcastOrderStatusToMany({
      order_id,
      user_id,
      merchant_ids: merchantIds,
      status: "PENDING",
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
    const { status, reason, user_id } = req.body || {};

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

    const affected = await Order.updateStatus(order_id, normalized, reasonStr);
    if (!affected) return res.status(404).json({ message: "Order not found" });

    // merchants linked to this order
    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    const merchant_ids = bizRows.map((r) => r.business_id);

    broadcastOrderStatusToMany({
      order_id,
      user_id,
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
