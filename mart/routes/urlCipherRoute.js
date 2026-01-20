const express = require("express");
const router = express.Router();
const {
  createEncryptedUrlController,
  openEncryptedUrlController,
} = require("../controllers/urlCipherController");

// Create shareable encrypted link
router.post("/", createEncryptedUrlController);

// Anyone opening this link gets the same output as the original raw URL (GET proxy)
router.get("/:token", openEncryptedUrlController);

module.exports = router;
