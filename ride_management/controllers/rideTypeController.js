// controllers/rideTypeController.js
const path = require("path");
const fsp = require("fs").promises;

const rideTypeModel = require("../models/rideTypeModel");
const { toWebPath } = require("../middleware/uploadRideTypeImage");

// sanitize actor info
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function getActor(req) {
  return {
    user_id:
      toIntOrNull(req.user?.user_id) ?? // set only on delete via authAccessToken
      toIntOrNull(req.headers["x-admin-id"]) ??
      toIntOrNull(req.body?.user_id) ??
      null,
    admin_name:
      req.user?.admin_name ?? // set only on delete via authAccessToken
      req.headers["x-admin-name"] ??
      req.body?.admin_name ??
      null,
  };
}

function isLocalUploadsPath(p) {
  return p && p.startsWith("/uploads/");
}
function toAbsoluteUploadsPath(webPath) {
  return path.join(process.cwd(), webPath.replace(/^\/+/, ""));
}
async function safeUnlink(absPath) {
  try {
    await fsp.unlink(absPath);
    return true;
  } catch {
    return false;
  }
}

// Prefer uploaded file; fallback to body.icon_url or body.image
function extractIncomingIcon(req) {
  if (req.file) return toWebPath(req.file);

  const raw = (req.body?.icon_url ?? req.body?.image ?? "").toString().trim();
  if (!raw) return null;

  if (raw.startsWith("/uploads/")) return raw;
  if (raw.startsWith("uploads/")) return `/${raw}`;

  try {
    const u = new URL(raw);
    return u.pathname || raw;
  } catch {
    return raw; // accept as-is (CDN)
  }
}

function cleanupNewUploadIfAny(req) {
  const iconPath = extractIncomingIcon(req);
  if (req.file && isLocalUploadsPath(iconPath)) {
    return safeUnlink(toAbsoluteUploadsPath(iconPath));
  }
  return Promise.resolve(false);
}

const createRideType = async (req, res) => {
  try {
    const actor = getActor(req);
    const iconPath = extractIncomingIcon(req);

    const payload = {
      name: req.body?.name,
      code: req.body?.code,
      description: req.body?.description,
      base_fare: req.body?.base_fare,
      per_km_rate: req.body?.per_km_rate,
      min_fare: req.body?.min_fare,
      cancellation_fee: req.body?.cancellation_fee,
      capacity: req.body?.capacity,
      vehicle_type: req.body?.vehicle_type,
      icon_url: iconPath || req.body?.icon_url || null,
      is_active: req.body?.is_active,
    };

    if (
      !payload.name ||
      !payload.code ||
      payload.base_fare == null ||
      payload.per_km_rate == null ||
      payload.min_fare == null ||
      payload.cancellation_fee == null ||
      payload.capacity == null
    ) {
      await cleanupNewUploadIfAny(req);
      return res.status(400).json({
        success: false,
        message:
          "name, code, base_fare, per_km_rate, min_fare, cancellation_fee, capacity are required",
      });
    }

    const result = await rideTypeModel.createRideType(
      payload,
      actor.user_id,
      actor.admin_name
    );

    if (result.exists) {
      await cleanupNewUploadIfAny(req);
      return res
        .status(409)
        .json({ success: false, message: "Ride type already exists" });
    }

    res.status(201).json({
      success: true,
      message: "Ride type created successfully",
      id: result.insertId,
    });
  } catch (error) {
    await cleanupNewUploadIfAny(req);
    console.error("Error creating ride type:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateRideType = async (req, res) => {
  try {
    const actor = getActor(req);
    const id = req.params.id;

    const current = await rideTypeModel.getRideTypeById(id);
    if (!current) {
      await cleanupNewUploadIfAny(req);
      return res
        .status(404)
        .json({ success: false, message: "Ride type not found" });
    }

    const incomingIcon = extractIncomingIcon(req);
    const iconToStore = incomingIcon ?? current.icon_url ?? null;

    const payload = {
      name: req.body?.name ?? current.name,
      code: req.body?.code ?? current.code,
      description: req.body?.description ?? current.description,
      base_fare: req.body?.base_fare ?? current.base_fare,
      per_km_rate: req.body?.per_km_rate ?? current.per_km_rate,
      min_fare: req.body?.min_fare ?? current.min_fare,
      cancellation_fee: req.body?.cancellation_fee ?? current.cancellation_fee,
      capacity: req.body?.capacity ?? current.capacity,
      vehicle_type: req.body?.vehicle_type ?? current.vehicle_type,
      icon_url: iconToStore,
      is_active: req.body?.is_active ?? current.is_active,
    };

    const affected = await rideTypeModel.updateRideType(
      id,
      payload,
      actor.user_id,
      actor.admin_name
    );

    if (affected === 0) {
      await cleanupNewUploadIfAny(req);
      return res
        .status(404)
        .json({ success: false, message: "Ride type not found" });
    }

    if (
      incomingIcon &&
      incomingIcon !== current.icon_url &&
      isLocalUploadsPath(current.icon_url || "")
    ) {
      await safeUnlink(toAbsoluteUploadsPath(current.icon_url));
    }

    res.json({ success: true, message: "Ride type updated" });
  } catch (error) {
    await cleanupNewUploadIfAny(req);
    console.error("Error updating ride type:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const getAllRideTypes = async (_req, res) => {
  try {
    const rideTypes = await rideTypeModel.getRideTypes();
    res.json({ success: true, data: rideTypes });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const getRideTypeById = async (req, res) => {
  try {
    const id = req.params.id;
    const rideType = await rideTypeModel.getRideTypeById(id);
    if (!rideType) {
      return res
        .status(404)
        .json({ success: false, message: "Ride type not found" });
    }
    res.json({ success: true, data: rideType });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteRideType = async (req, res) => {
  try {
    const actor = getActor(req);
    const id = req.params.id;

    const { affectedRows, deletedIcon } = await rideTypeModel.deleteRideType(
      id,
      actor.user_id,
      actor.admin_name
    );

    if (affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Ride type not found" });
    }

    if (deletedIcon && isLocalUploadsPath(deletedIcon)) {
      await safeUnlink(toAbsoluteUploadsPath(deletedIcon));
    }

    res
      .status(200)
      .json({ success: true, message: "Ride type deleted successfully" });
  } catch (error) {
    console.error("Error deleting ride type:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  createRideType,
  updateRideType,
  getAllRideTypes,
  getRideTypeById,
  deleteRideType,
};
