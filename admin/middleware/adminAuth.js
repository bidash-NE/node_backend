// middlewares/adminAuth.js
const jwt = require("jsonwebtoken");

// Use your env var name here 👇
const ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET || "your_access_token_secret_here";

function adminOnly(req, res, next) {
  try {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: "Authorization header missing.",
      });
    }

    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        error: "Invalid authorization format. Use Bearer <access_token>.",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
      console.log("Decoded token:", decoded.role);
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired token.",
      });
    }

    // Expect token payload to have at least: { user_id, role }
    if (!decoded || !decoded.role) {
      return res.status(403).json({
        success: false,
        error: "Invalid token payload.",
      });
    }

    const allowedRoles = ["admin", "super admin"];
    if (!allowedRoles.includes(decoded.role)) {
      return res.status(403).json({
        success: false,
        error: "Access denied. Admin or super admin only.",
      });
    }

    // Attach user info for downstream handlers
    req.user = decoded;

    return next();
  } catch (err) {
    console.error("adminOnly middleware error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
}

module.exports = adminOnly;
