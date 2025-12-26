// routes/scheduledOrdersRoutes.js
const express = require("express");
const router = express.Router();

const {
  scheduleOrder,
  listScheduledOrders,
  cancelScheduledOrder,
  listScheduledOrdersByBusiness,
} = require("../controllers/scheduledOrdersController");

const { uploadDeliveryPhotos } = require("../middleware/uploadDeliveryPhoto");

router.post("/scheduled-orders", uploadDeliveryPhotos, scheduleOrder);

// FETCH all scheduled orders for a user
router.get("/scheduled-orders/:user_id", listScheduledOrders);

// FETCH all scheduled orders for a business
// e.g. /api/scheduled-orders/business/123
router.get(
  "/scheduled-orders/business/:businessId",
  listScheduledOrdersByBusiness
);

// CANCEL one scheduled order
router.delete("/scheduled-orders/:user_id/:jobId", cancelScheduledOrder);

module.exports = router;
