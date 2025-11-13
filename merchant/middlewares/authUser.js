// middlewares/authUser.js
const jwt = require("jsonwebtoken");

/**
 * Auth middleware for user-side APIs.
 * Requires:
 *   - Authorization: Bearer <access_token>
 *   - ACCESS_TOKEN_SECRET in env
 * Populates req.user = { user_id, role, phone, ... }
 */
function authUser(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    if (!hdr.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Missing or invalid Authorization header",
      });
    }

    const token = hdr.slice(7).trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Missing access token",
      });
    }

    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      console.error("[authUser] ACCESS_TOKEN_SECRET is not set");
      return res
        .status(500)
        .json({ success: false, message: "Auth not configured" });
    }

    const decoded = jwt.verify(token, secret);
    const user_id = decoded.user_id ?? decoded.uid ?? decoded.id ?? decoded.sub;

    if (!user_id) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
    }

    req.user = {
      ...decoded,
      user_id,
    };
    return next();
  } catch (e) {
    console.error("[authUser] error:", e?.message || e);
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
}

module.exports = authUser;
