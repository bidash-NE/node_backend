// routes/adminRoutes.js
const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");

// Lists
router.get("/users", adminController.getAllNormalUsers);
router.get("/drivers", adminController.getAllDrivers);
router.get("/admins", adminController.getAllAdmins);

// Mutations (admin-only endpoints typically)
// Pass acting admin via auth middleware (sets req.user) OR headers:
//   x-admin-id: <number>
//   x-admin-name: <string>
router.post("/deactivate/:user_id", adminController.deactivateUser);
router.post("/activate/:user_id", adminController.activateUser);
router.delete("/delete/:user_id", adminController.deleteUser);

module.exports = router;
