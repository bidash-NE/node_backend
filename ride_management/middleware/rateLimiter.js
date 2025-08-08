const rateLimit = require("express-rate-limit");

// Create a rate limiter for ride requests
const rideRequestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5000, // limit each IP/user to 5 requests per minute
  message: "❌ Too many ride requests. Please try again after a minute.",
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  rideRequestLimiter,
};
