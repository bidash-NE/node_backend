// src/routes/withdrawals.routes.js
const express = require("express");
const C = require("../controllers/withdrawals.controller");

const router = express.Router();

/* USER (no auth) */
router.post("/wallet/withdrawals", C.createWithdrawal);
router.get("/wallet/withdrawals", C.listMyWithdrawals);
router.post("/wallet/withdrawals/:id/cancel", C.cancelWithdrawal);

/* ADMIN (no auth) */
router.get("/admin/withdrawals", C.adminList);
router.post("/admin/withdrawals/:id/needs-info", C.adminNeedsInfoOne);
router.post("/admin/withdrawals/:id/approve", C.adminApproveOne);
router.post("/admin/withdrawals/:id/reject", C.adminRejectOne);
router.post("/admin/withdrawals/:id/mark-paid", C.adminMarkPaidOne);
router.post("/admin/withdrawals/:id/fail", C.adminFailOne);

module.exports = router;
