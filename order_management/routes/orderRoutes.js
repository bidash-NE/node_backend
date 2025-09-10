// routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const orderCtrl = require("../controllers/orderControllers");

/* validators */
const validateOrderId = (req, res, next) => {
  const oid = String(req.params.order_id || "").trim();
  if (oid.startsWith("ORD-") && oid.length >= 8) return next();
  return res.status(400).json({ message: "Invalid order_id" });
};
const validateBusinessId = (req, res, next) => {
  const bid = Number(req.params.business_id);
  if (Number.isFinite(bid) && bid > 0) return next();
  return res.status(400).json({ message: "Invalid business_id" });
};
const validateUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  if (Number.isFinite(uid) && uid > 0) return next();
  return res.status(400).json({ message: "Invalid user_id" });
};

/* CRUD */
router.post("/orders", orderCtrl.createOrder);
router.get("/orders", orderCtrl.getOrders);
router.get("/orders/:order_id", validateOrderId, orderCtrl.getOrderById);
router.put("/orders/:order_id", validateOrderId, orderCtrl.updateOrder);
router.delete("/orders/:order_id", validateOrderId, orderCtrl.deleteOrder);

/* Status-only update */
router.put(
  "/orders/:order_id/status",
  validateOrderId,
  orderCtrl.updateOrderStatus
);

/* Business-scoped */
router.get(
  "/orders/business/:business_id",
  validateBusinessId,
  orderCtrl.getOrdersByBusinessId
);
router.get(
  "/orders/business/:business_id/grouped",
  validateBusinessId,
  orderCtrl.getBusinessOrdersGroupedByUser
);

/* === User-facing === */
router.get(
  "/users/:user_id/orders",
  validateUserId,
  orderCtrl.getOrdersForUser
);

module.exports = router;
