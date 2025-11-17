// routes/scheduledOrdersRoutes.js
const express = require("express");
const router = express.Router();

const {
  scheduleOrder,
  listScheduledOrders,
  cancelScheduledOrder,
} = require("../controllers/scheduledOrdersController");

// CREATE (body has user_id + scheduled_at + order fields)
router.post("/scheduled-orders", scheduleOrder);

// FETCH all scheduled orders for a user
router.get("/scheduled-orders/:user_id", listScheduledOrders);

// CANCEL one scheduled order
router.delete("/scheduled-orders/:user_id/:jobId", cancelScheduledOrder);

module.exports = router;
