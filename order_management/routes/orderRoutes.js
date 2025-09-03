const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderControllers");

router.post("/", orderController.createOrder);
router.get("/", orderController.getOrders);
router.get("/:order_id", orderController.getOrderById);
router.get("/business/:business_id", orderController.getOrdersByBusinessId);
router.put("/:order_id", orderController.updateOrder);
router.patch("/:order_id/status", orderController.updateOrderStatus);
router.delete("/:order_id", orderController.deleteOrder);

module.exports = router;
