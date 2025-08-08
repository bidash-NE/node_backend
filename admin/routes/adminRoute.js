const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");

// Route to fetch users with role 'user'
router.get("/users", adminController.getAllNormalUsers);
// 🔥 Route to get users with role 'driver'
router.get("/drivers", adminController.getAllDrivers);
module.exports = router;
