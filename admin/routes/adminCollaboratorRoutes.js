// routes/adminCollaboratorRoutes.js
const express = require("express");
const router = express.Router();

const ensureAdmin = require("../middleware/ensureAdmin");
const ctrl = require("../controllers/adminCollaboratorController");

// Protect ALL CRUD with ensureAdmin (role + identity check)
router.get("/", ensureAdmin, ctrl.list);
router.get("/:id", ensureAdmin, ctrl.getOne);
router.post("", ensureAdmin, ctrl.create);
router.put("/:id", ensureAdmin, ctrl.update);
router.delete("/:id", ensureAdmin, ctrl.remove);

module.exports = router;
