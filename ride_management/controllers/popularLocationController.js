const redis = require("../config/redis");

exports.getPopularDropoffLocations = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;

    const locations = await redis.zrange(
      "popular:dropoff_locations",
      0,
      limit - 1,
      {
        rev: true,
        withScores: true,
      }
    );

    if (!locations.length) {
      return res.json({ message: "No popular dropoff locations found." });
    }

    const result = [];

    for (let i = 0; i < locations.length; i += 2) {
      result.push({
        location: locations[i],
        count: parseInt(locations[i + 1]),
      });
    }

    res.json(result);
  } catch (error) {
    console.error("🔥 Error fetching popular dropoff locations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
