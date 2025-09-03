const Order = require("../models/orderModels");

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

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.order_id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getOrdersByBusinessId = async (req, res) => {
  try {
    const businessId = req.params.business_id;
    const items = await Order.findByBusinessId(businessId);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const order_id = req.params.order_id;
    if (!status) return res.status(400).json({ message: "Status is required" });

    const [result] = await require("../models/orderModels").update(order_id, {
      status,
    });
    if (!result) return res.status(404).json({ message: "Order not found" });

    res.json({ message: "Order status updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
