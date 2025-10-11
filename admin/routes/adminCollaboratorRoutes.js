// routes/adminCollaboratorRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/adminCollaboratorController");

/**
 * JSON-based auth:
 * - POST, PUT, DELETE require { auth: { user_id, admin_name } }
 * - GET routes are public (no admin check)
 */

// Public routes
router.get("/", ctrl.list); // GET all collaborators
router.get("/:id", ctrl.getOne); // GET one collaborator by ID

// Protected routes (require admin verification)
router.post("/", ctrl.create); // POST new collaborator
router.put("/:id", ctrl.update); // PUT update collaborator
router.delete("/:id", ctrl.remove); // DELETE collaborator

module.exports = router;
