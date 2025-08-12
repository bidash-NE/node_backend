const express = require("express");
const router = express.Router();
const profileController = require("../controllers/profileController");
const upload = require("../middleware/upload");

// Get profile
router.get("/:user_id", profileController.getProfile);

// Update profile (with optional image)
router.put(
  "/:user_id",
  upload.single("profile_image"),
  profileController.updateProfile
);
router.put("/password/:user_id", profileController.changePassword);
module.exports = router;
