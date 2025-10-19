// routes/walletRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/walletController");

// MAIN REST ENDPOINTS
router.post("/create", ctrl.create); // POST /wallet (JSON)

router.get("/getall", ctrl.getAll); // GET /wallet
router.get("/getone/:wallet_id", ctrl.getByIdParam); // GET /wallet/NET000004

router.put("/:wallet_id/:status", ctrl.updateStatusByParam); // PUT /wallet/NET000004/ACTIVE

router.delete("/delete/:wallet_id", ctrl.removeByParam); // DELETE /wallet/NET000004

module.exports = router;
