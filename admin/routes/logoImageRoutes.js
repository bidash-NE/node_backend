const express = require("express");
const multer = require("multer");

const router = express.Router();

const LogoImageController = require("../controllers/logoImageController");
const { logoImageUpload } = require("../middleware/upload");

// Multer error handler
function handleMulterError(err, _req, res, next) {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Image file must be less than 5MB",
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  return res.status(400).json({
    success: false,
    message: err.message || "File upload error",
  });
}

// Form-data fields:
// name
// service_type
// image

router.post(
  "/",
  logoImageUpload.single("image"),
  handleMulterError,
  LogoImageController.create
);

router.get("/", LogoImageController.getAll);

// Keep this before "/:id"
router.post("/bulk-delete", LogoImageController.bulkDelete);

router.get("/:id", LogoImageController.getById);

router.put(
  "/:id",
  logoImageUpload.single("image"),
  handleMulterError,
  LogoImageController.update
);

router.delete("/:id", LogoImageController.delete);

module.exports = router;