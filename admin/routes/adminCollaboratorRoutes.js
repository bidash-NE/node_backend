// routes/adminCollaboratorRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/adminCollaboratorController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

/* ---------------- limiters ---------------- */
const publicReadLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

const adminWriteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30,
  message: "Too many admin changes. Please try again later.",
});

/* validators */
const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

// Public routes
router.get("/", publicReadLimiter, ctrl.list);
router.get("/:id", publicReadLimiter, validateIdParam, ctrl.getOne);

// Protected routes (still rate-limit, even if controller checks auth JSON)
router.post("/", adminWriteLimiter, ctrl.create);
router.put("/:id", adminWriteLimiter, validateIdParam, ctrl.update);
router.delete("/:id", adminWriteLimiter, validateIdParam, ctrl.remove);

module.exports = router;
