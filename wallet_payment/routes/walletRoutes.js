// routes/walletRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/walletController");

// CREATE WALLET
router.post("/create", ctrl.create);

// READ (GET)
router.get("/getall", ctrl.getAll);
router.get("/getone/:wallet_id", ctrl.getByIdParam);

// ✅ NEW: get user_name by wallet_id
router.get("/:wallet_id/user-name", ctrl.getUserNameByWalletId);

router.get("/:wallet_id", ctrl.getByIdParam);
router.get("/getbyuser/:user_id", ctrl.getByUserId);

// UPDATE STATUS
router.put("/:wallet_id/:status", ctrl.updateStatusByParam);

// DELETE WALLET
router.delete("/delete/:wallet_id", ctrl.removeByParam);

// ✅ ADMIN TIP TRANSFER (Send Nu from admin wallet to another wallet)
router.post("/admin/tip", ctrl.adminTipTransfer);

// ✅ SET / CREATE T-PIN for a wallet
router.post("/:wallet_id/t-pin", ctrl.setTPin);

// CHANGE T-PIN (verify old T-PIN first)
router.patch("/:wallet_id/t-pin", ctrl.changeTPin);

// ✅ FORGOT T-PIN: request OTP (send mail)
router.post("/:wallet_id/forgot-tpin", ctrl.forgotTPinRequest);

// ✅ FORGOT T-PIN: verify OTP and set new T-PIN
router.post("/:wallet_id/forgot-tpin/verify", ctrl.forgotTPinVerify);

// ✅ NEW: FORGOT T-PIN via SMS (send OTP)
router.post("/:wallet_id/forgot-tpin-sms", ctrl.forgotTPinRequestSms);

// ✅ NEW: FORGOT T-PIN via SMS (verify OTP + set new T-PIN)
router.post("/:wallet_id/forgot-tpin-sms/verify", ctrl.forgotTPinVerifySms);

router.post("/transfer", ctrl.userTransfer);

router.get("/:user_id/has-tpin", ctrl.checkTPinByUserId);

module.exports = router;
