// routes/rideGroup.routes.js
import { Router } from "express";
import {
  createRideInvite,
  getInviteByCode,
  joinByInviteCode,
  listParticipants,
  leaveRide,
  removeGuest,
  revokeInvite,
} from "../controllers/rideGroup.controller.js";

const router = Router();

/* -------- invites -------- */
router.post("/rides/:ride_id/invites", createRideInvite);
router.post("/rides/:ride_id/invites/:code/revoke", revokeInvite);

// invite lookup + join
router.get("/ride-invites/:code", getInviteByCode);
router.post("/ride-invites/:code/join", joinByInviteCode);

/* -------- participants -------- */
router.get("/rides/:ride_id/participants", listParticipants);
router.post("/rides/:ride_id/participants/leave", leaveRide);
router.post("/rides/:ride_id/participants/:user_id/remove", removeGuest);

export default router;
