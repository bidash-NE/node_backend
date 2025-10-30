const express = require("express");
const router = express.Router();
const orderCtrl = require("../controllers/orderControllers");

/* validators */
const validOrderId = (req, res, next) => {
  const id = String(req.params.order_id || "").trim();
  return id.startsWith("ORD-")
    ? next()
    : res.status(400).json({ message: "Invalid order_id" });
};
const validBizId = (req, res, next) => {
  const bid = Number(req.params.business_id);
  return Number.isFinite(bid) && bid > 0
    ? next()
    : res.status(400).json({ message: "Invalid business_id" });
};
const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  return Number.isFinite(uid) && uid > 0
    ? next()
    : res.status(400).json({ message: "Invalid user_id" });
};

/* CRUD */
router.post("/orders", orderCtrl.createOrder);
router.get("/orders", orderCtrl.getOrders);
router.get("/orders/:order_id", validOrderId, orderCtrl.getOrderById);
router.put("/orders/:order_id", validOrderId, orderCtrl.updateOrder);
router.delete("/orders/:order_id", validOrderId, orderCtrl.deleteOrder);
router.put(
  "/orders/:order_id/status",
  validOrderId,
  orderCtrl.updateOrderStatus
);

/* Business-scoped */
router.get(
  "/orders/business/:business_id",
  validBizId,
  orderCtrl.getOrdersByBusinessId
);
router.get(
  "/orders/business/:business_id/grouped",
  validBizId,
  orderCtrl.getBusinessOrdersGroupedByUser
);

/* User-facing */
router.get("/users/:user_id/orders", validUserId, orderCtrl.getOrdersForUser);

module.exports = router;
