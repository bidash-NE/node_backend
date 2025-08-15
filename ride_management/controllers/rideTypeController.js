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
      toIntOrNull(req.user?.user_id) ??
      toIntOrNull(req.headers["x-admin-id"]) ??
      toIntOrNull(req.body?.user_id) ??
      null,
    admin_name:
      req.user?.admin_name ??
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

// Prefer uploaded file; fallback to body.image (absolute URL or /uploads path)
function extractIncomingImage(req) {
  if (req.file) return toWebPath(req.file);
  const raw = (req.body?.image || "").toString().trim();
  if (!raw) return null;
  if (raw.startsWith("/uploads/")) return raw;
  if (raw.startsWith("uploads/")) return `/${raw}`;
  try {
    const u = new URL(raw);
    return u.pathname || raw; // strip host
  } catch {
    return raw; // accept as-is (CDN)
  }
}

const createRideType = async (req, res) => {
  try {
    const actor = getActor(req);
    const imagePath = extractIncomingImage(req);

    const result = await rideTypeModel.createRideType(
      {
        name: req.body?.name,
        image: imagePath || null,
        base_fare: req.body?.base_fare,
        per_km: req.body?.per_km,
        per_min: req.body?.per_min,
      },
      actor.user_id,
      actor.admin_name
    );

    if (result.exists) {
      // clean up newly uploaded file if duplicate
      if (req.file && isLocalUploadsPath(imagePath)) {
        await safeUnlink(toAbsoluteUploadsPath(imagePath));
      }
      return res.status(409).json({ message: "Ride type already exists" });
    }

    res.status(201).json({
      message: "Ride type created successfully",
      ride_type_id: result.insertId,
    });
  } catch (error) {
    // clean up uploaded file on error
    const imagePath = extractIncomingImage(req);
    if (req.file && isLocalUploadsPath(imagePath)) {
      await safeUnlink(toAbsoluteUploadsPath(imagePath));
    }
    console.error("Error creating ride type:", error);
    res.status(500).json({ error: error.message });
  }
};

const updateRideType = async (req, res) => {
  try {
    const actor = getActor(req);
    const id = req.params.id;

    // fetch current to know previous image
    const current = await rideTypeModel.getRideTypeById(id);
    if (!current) {
      if (req.file) {
        const newImg = extractIncomingImage(req);
        if (isLocalUploadsPath(newImg))
          await safeUnlink(toAbsoluteUploadsPath(newImg));
      }
      return res.status(404).json({ message: "Ride type not found" });
    }

    const incomingImage = extractIncomingImage(req);
    const imageToStore = incomingImage ?? current.image ?? null;

    const affected = await rideTypeModel.updateRideType(
      id,
      {
        name: req.body?.name,
        image: imageToStore,
        base_fare: req.body?.base_fare,
        per_km: req.body?.per_km,
        per_min: req.body?.per_min,
      },
      actor.user_id,
      actor.admin_name
    );

    if (affected === 0) {
      // rollback: remove newly uploaded file if any
      if (req.file && isLocalUploadsPath(incomingImage)) {
        await safeUnlink(toAbsoluteUploadsPath(incomingImage));
      }
      return res.status(404).json({ message: "Ride type not found" });
    }

    // delete previous local image if new local one replaced it
    if (
      incomingImage &&
      incomingImage !== current.image &&
      isLocalUploadsPath(current.image || "")
    ) {
      await safeUnlink(toAbsoluteUploadsPath(current.image));
    }

    res.json({ message: "Ride type updated" });
  } catch (error) {
    // cleanup new uploaded file on error
    const incomingImage = extractIncomingImage(req);
    if (req.file && isLocalUploadsPath(incomingImage)) {
      await safeUnlink(toAbsoluteUploadsPath(incomingImage));
    }
    console.error("Error updating ride type:", error);
    res.status(500).json({ error: error.message });
  }
};

const getAllRideTypes = async (_req, res) => {
  try {
    const rideTypes = await rideTypeModel.getRideTypes();
    res.json(rideTypes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getRideTypeById = async (req, res) => {
  try {
    const id = req.params.id;
    const rideType = await rideTypeModel.getRideTypeById(id);
    if (!rideType) {
      return res.status(404).json({ message: "Ride type not found" });
    }
    res.json(rideType);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteRideType = async (req, res) => {
  try {
    const actor = getActor(req);
    const { ride_type_id } = req.params;

    // delete from DB (model will also return image path if existed)
    const { affectedRows, deletedImage } = await rideTypeModel.deleteRideType(
      ride_type_id,
      actor.user_id,
      actor.admin_name
    );

    if (affectedRows === 0) {
      return res.status(404).json({ message: "Ride type not found" });
    }

    // best-effort: remove local image
    if (deletedImage && isLocalUploadsPath(deletedImage)) {
      await safeUnlink(toAbsoluteUploadsPath(deletedImage));
    }

    res.status(200).json({ message: "Ride type deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createRideType,
  updateRideType,
  getAllRideTypes,
  getRideTypeById,
  deleteRideType,
};
