// routes/deliveredOrderRoutes.js
const express = require("express");
const router = express.Router();

const {
  listDeliveredOrders,
  deleteDeliveredOrder,
  deleteManyDeliveredOrders,
} = require("../controllers/deliveredOrderControllers");

function validUserId(req, res, next) {
  const userId = Number(req.params.user_id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid user_id" });
  }
  next();
}

function validOrderId(req, res, next) {
  const oid = String(req.params.order_id || "").trim();
  if (!oid || !/^ORD-\d+$/i.test(oid)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid order_id" });
  }
  next();
}

// GET delivered orders by user
router.get("/:user_id", validUserId, listDeliveredOrders);

// DELETE ONE delivered order by user (items cascade)
router.delete(
  "/:user_id/:order_id",
  validUserId,
  validOrderId,
  deleteDeliveredOrder
);

// DELETE MANY delivered orders by user (body: { order_ids: [...] })
router.delete("/:user_id", validUserId, deleteManyDeliveredOrders);

module.exports = router;
