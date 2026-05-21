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
const { documentUpload } = require("../middleware/upload");

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
  windowMs: 2 * 60 * 1000, // 2 min
  max: 20,
  message: "Too many login attempts. Please try again later.",
});

const logoutLimiter = makeLimiter({
  windowMs: 2 * 60 * 1000, // 2 min
  max: 60,
  message: "Too many requests. Please slow down.",
});

// Document upload endpoint
router.post("/upload-document", documentUpload.single("document"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }
  const baseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const url = `${baseUrl}/uploads/documents/${req.file.filename}`;
  return res.status(200).json({ success: true, url });
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
