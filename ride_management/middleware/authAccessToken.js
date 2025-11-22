// middleware/authAccessToken.js
const jwt = require("jsonwebtoken");
const db = require("../config/db");

async function authAccessToken(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Missing Authorization Bearer token",
      });
    }

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    console.log("✅ decoded access token =>", decoded);

    const user_id =
      decoded.user_id ?? decoded.id ?? decoded.userId ?? decoded.sub ?? null;

    const role = (decoded.role || "").toString().trim().toLowerCase();

    if (!user_id) {
      return res.status(401).json({
        success: false,
        message: "Invalid token: user_id missing",
      });
    }

    // allow only admin roles
    if (role !== "super admin" && role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admin or super admin can delete ride types",
      });
    }

    // ✅ fetch admin name from users.user_name
    const [rows] = await db.query(
      `SELECT user_name AS admin_name FROM users WHERE user_id = ? LIMIT 1`,
      [user_id]
    );

    const admin_name = rows?.[0]?.admin_name
      ? String(rows[0].admin_name).trim()
      : null;

    if (!admin_name) {
      return res.status(401).json({
        success: false,
        message: "user_name not found for this user_id",
      });
    }

    req.user = {
      user_id: Number(user_id),
      admin_name,
      role,
      raw: decoded,
    };

    return next();
  } catch (err) {
    console.error("authAccessToken error:", err.message);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired access token",
    });
  }
}

module.exports = authAccessToken;
