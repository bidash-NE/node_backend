// routes/transactionHistoryRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/transactionHistoryController");

// GET /transactions/wallet/NET000004?limit=50&cursor=...&start=...&end=...&direction=CR|DR&journal=...&q=...
router.get("/wallet/:wallet_id", ctrl.getByWallet);

// GET /transactions/user/123?...
router.get("/user/:user_id", ctrl.getByUser);

// GET /transactions/getall?limit=...  (Consider admin-only)
router.get("/getall", ctrl.getAll);

module.exports = router;
