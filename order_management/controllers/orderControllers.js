// controllers/orderControllers.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");

// Keep statuses centralized
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

// purely for merchant preview banner text; uses provided values only
function buildPreview(items = [], totals) {
  const parts = items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.item_name}`);
  const more = items.length > 2 ? `, +${items.length - 2} more` : "";
  const total = Number(totals?.total_amount ?? 0).toFixed(2);
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

    // HARD REQUIREMENTS: Frontend must send the exact monetary breakdown.
    // We do NOT compute anything here.
    // Required top-level fields:
    const mustHaveTop = ["total_amount", "discount_amount"];
    for (const f of mustHaveTop) {
      if (payload[f] == null || payload[f] === "") {
        return res
          .status(400)
          .json({ message: `Missing required field: ${f}` });
      }
    }

    // Required per-line fields:
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

    // 1) Persist order EXACTLY as provided (uppercasing status only).
    const order_id = await Order.create({
      ...payload,
      status: (payload.status || "PENDING").toUpperCase(),
      // NOTE: no computeTotals, no math—trust frontend.
    });

    // 2) Group items by business_id to know which merchant rooms to notify
    const byBiz = new Map();
    for (const it of items) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const merchantIds = Array.from(byBiz.keys());

    // 3) Insert notification row(s) first, then emit (conditional)
    for (const merchant_id of merchantIds) {
      const [[biz]] = await db.query(
        `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
        [merchant_id]
      );
      if (!biz) continue;

      const its = byBiz.get(merchant_id) || [];
      const title = `New order #${order_id}`;
      const preview = buildPreview(its, {
        total_amount: payload.total_amount,
      });

      await insertAndEmitNotification({
        merchant_id,
        user_id,
        order_id,
        title,
        body_preview: preview,
        type: "order:create",
        totals: {
          // pass through exactly what FE sent (or subset used by merchant UI)
          items_subtotal: payload.items_subtotal ?? null,
          platform_fee_total: payload.platform_fee ?? null,
          delivery_fee_total: payload.delivery_fee ?? null,
          discount_amount: payload.discount_amount,
          total_amount: payload.total_amount,
        },
      });
    }

    // 4) Broadcast initial status to user + all merchant rooms
    broadcastOrderStatusToMany({
      order_id,
      user_id,
      merchant_ids: merchantIds,
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
