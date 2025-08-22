// routes/adminRoutes.js
const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");

// Lists
router.get("/users", adminController.getAllNormalUsers);
router.get("/drivers", adminController.getAllDrivers);
router.get("/admins", adminController.getAllAdmins);

// Merchants + business details + profile image
router.get("/merchants", adminController.getAllMerchantsWithDetails);

// Mutations (admin-only endpoints typically)
router.post("/deactivate/:user_id", adminController.deactivateUser);
router.post("/activate/:user_id", adminController.activateUser);
router.delete("/delete/:user_id", adminController.deleteUser);

module.exports = router;
