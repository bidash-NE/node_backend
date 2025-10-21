const express = require("express");
const {
  registerUser,
  loginUser,
  logoutUser,
} = require("../controllers/registrationController");

const router = express.Router();

// Registration endpoint
router.post("/register", registerUser);

// Login endpoint
router.post("/login", loginUser);
router.post("/logout/:user_id", logoutUser);
module.exports = router;
