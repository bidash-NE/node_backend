// routes/registrationRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  registerUser,
  loginUser,
  logoutUser,
  verifyActiveSession,
  refreshAccessToken,
} = require("../controllers/registrationController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

/* ---------------- validators ---------------- */
const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  if (Number.isFinite(uid) && uid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid user_id" });
};

/* ---------------- limiters ---------------- */
const registerLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many registration attempts. Please try again later.",
});

const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: "Too many login attempts. Please try again later.",
});

const logoutLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 60,
  message: "Too many requests. Please slow down.",
});

// Registration endpoint
router.post("/register", registerLimiter, registerUser);

// Login endpoint
router.post("/login", loginLimiter, loginUser);

// Logout
router.post("/logout/:user_id", logoutLimiter, validUserId, logoutUser);

router.post("/verify-session", loginLimiter, verifyActiveSession);

router.post("/refresh-token", loginLimiter, refreshAccessToken);
module.exports = router;
