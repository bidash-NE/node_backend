const adminModel = require("../models/adminModel");

// Controller to handle the GET request
exports.getAllNormalUsers = async (req, res) => {
  try {
    const users = await adminModel.fetchUsersByRole();
    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
// 🔥 New controller to get drivers
exports.getAllDrivers = async (req, res) => {
  try {
    const drivers = await adminModel.fetchDrivers();
    res.status(200).json(drivers);
  } catch (error) {
    console.error("Error fetching drivers:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
