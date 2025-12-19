// routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const orderCtrl = require("../controllers/orderControllers");
const { uploadDeliveryPhoto } = require("../middleware/uploadDeliveryPhoto");

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

/**
 * ✅ Supports BOTH:
 * - application/json
 * - multipart/form-data (payload + delivery_photo)
 *
 * multipart fields:
 * - payload: JSON string
 * - delivery_photo: image file
 */
router.post(
  "/orders",
  uploadDeliveryPhoto.single("delivery_photo"),
  orderCtrl.createOrder
);

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
router.get(
  "/orders/business/:business_id/status-counts",
  validBizId,
  orderCtrl.getOrderStatusCountsByBusiness
);

/* User-facing */
router.get("/users/:user_id/orders", validUserId, orderCtrl.getOrdersForUser);

/* User cancels */
router.patch(
  "/users/:user_id/orders/:order_id/cancel",
  validUserId,
  validOrderId,
  orderCtrl.cancelOrderByUser
);

module.exports = router;
