const express = require("express");
const router = express.Router();
const {
  getPopularDropoffLocations,
} = require("../controllers/popularLocationController");

router.get("/popular-dropoffs", getPopularDropoffLocations);

module.exports = router;
