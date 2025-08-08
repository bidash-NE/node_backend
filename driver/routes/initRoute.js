const express = require("express");
const { initializeDatabase } = require("../controllers/initController");

const router = express.Router();

router.get("/init-db", initializeDatabase);

module.exports = router;
