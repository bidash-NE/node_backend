// controllers/orderController.js
const Order = require("../models/orderModels");

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

exports.createOrder = async (req, res) => {
  try {
    const order_id = await Order.create(req.body);
    res.status(201).json({ order_id, message: "Order created successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getOrders = async (req, res) => {
  try {
    const orders = await Order.findAll();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Same grouped shape by order_id (merchant/admin) */
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

/** Flat items by business (legacy) */
exports.getOrdersByBusinessId = async (req, res) => {
  try {
    const businessId = req.params.business_id;
    const items = await Order.findByBusinessId(businessId);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Business grouped by user (merchant dashboard) */
exports.getBusinessOrdersGroupedByUser = async (req, res) => {
  try {
    const businessId = req.params.business_id;
    const data = await Order.findByBusinessGroupedByUser(businessId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/** === USER-FACING ===
 *  GET /api/users/:user_id/orders
 *  Returns array of orders with fields needed for the user app, including status_reason.
 */
exports.getOrdersForUser = async (req, res) => {
  try {
    const userId = req.params.user_id;
    const data = await Order.findByUserIdForApp(userId);
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
 * Update status — NOW requires a `reason` in body.
 * Body: { status: 'CONFIRMED' | 'CANCELLED' | ..., reason: '...' }
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

    // Require a non-empty reason for any status change
    const reasonStr = (reason ?? "").toString().trim();
    if (!reasonStr) {
      return res
        .status(400)
        .json({ message: "Reason is required for status change" });
    }

    const affected = await Order.updateStatus(order_id, normalized, reasonStr);
    if (!affected) return res.status(404).json({ message: "Order not found" });

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
