// routes/walletRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/walletController");

// CREATE WALLET
router.post("/create", ctrl.create);

// READ (GET)
router.get("/getall", ctrl.getAll);
router.get("/getone/:wallet_id", ctrl.getByIdParam);
router.get("/:wallet_id", ctrl.getByIdParam);
router.get("/getbyuser/:user_id", ctrl.getByUserId);

// UPDATE STATUS
router.put("/:wallet_id/:status", ctrl.updateStatusByParam);

// DELETE WALLET
router.delete("/delete/:wallet_id", ctrl.removeByParam);

// ✅ ADMIN TIP TRANSFER (Send Nu from admin wallet to another wallet)
router.post("/admin/tip", ctrl.adminTipTransfer);

module.exports = router;
