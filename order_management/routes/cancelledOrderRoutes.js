// routes/cancelledOrderRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/cancelledOrderControllers");

/* validators */
const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  return Number.isFinite(uid) && uid > 0
    ? next()
    : res.status(400).json({ message: "Invalid user_id" });
};

const validOrderId = (req, res, next) => {
  const id = String(req.params.order_id || "").trim();
  return id.startsWith("ORD-")
    ? next()
    : res.status(400).json({ message: "Invalid order_id" });
};

/* Fetch cancelled orders by user */
router.get(
  "/users/:user_id/cancelled-orders",
  validUserId,
  ctrl.getCancelledOrdersByUser
);

/* Delete ONE cancelled order (also deletes its cancelled items) */
router.delete(
  "/users/:user_id/cancelled-orders/:order_id",
  validUserId,
  validOrderId,
  ctrl.deleteCancelledOrder
);

/* Delete MANY cancelled orders (also deletes their cancelled items) */
router.delete(
  "/users/:user_id/cancelled-orders",
  validUserId,
  ctrl.deleteManyCancelledOrders
);

module.exports = router;
