// routes/walletRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/walletController");

// CREATE (JSON)
router.post("/create", ctrl.create);

// READ
router.get("/getall", ctrl.getAll); // Get all wallets
router.get("/getone/:wallet_id", ctrl.getByIdParam); // Get one by wallet_id
router.get("/:wallet_id", ctrl.getByIdParam); // Alt shorthand
router.get("/getbyuser/:user_id", ctrl.getByUserId); // ✅ Get by user_id

// UPDATE
router.put("/:wallet_id/:status", ctrl.updateStatusByParam);

// DELETE
router.delete("/delete/:wallet_id", ctrl.removeByParam);

module.exports = router;
