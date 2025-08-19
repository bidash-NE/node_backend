// routes/categoryRoute.js
const express = require("express");
const router = express.Router();

const {
  createCategoryCtrl,
  listCategoriesCtrl,
  listByBusinessTypeCtrl,
  updateCategoryCtrl,
  deleteCategoryCtrl,
} = require("../controllers/categoryController");

const { uploadCategoryImage } = require("../middlewares/categoryImage");

// For these routes :kind must be 'food' or 'mart'

// CREATE (supports multipart with file field "category_image")
router.post("/:kind", uploadCategoryImage(), createCategoryCtrl);

// UPDATE (partial; auto-delete old image if replaced)
router.put("/:kind/:id", uploadCategoryImage(), updateCategoryCtrl);

// DELETE (also deletes the old image file)
router.delete("/:kind/:id", deleteCategoryCtrl);

// FETCH ALL (by kind)
router.get("/:kind", listCategoriesCtrl);

// FETCH BY business_type (within kind) — query param ?business_type=food|mart (defaults to :kind)
router.get("/:kind/by-type", listByBusinessTypeCtrl);

module.exports = router;
