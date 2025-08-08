const rideTypeModel = require("../models/rideTypeModel");

const createRideType = async (req, res) => {
  try {
    const result = await rideTypeModel.createRideType(req.body);

    if (result.exists) {
      return res.status(409).json({ message: "Ride type already exists" });
    }

    res.status(201).json({
      message: "Ride type created successfully",
      ride_type_id: result.insertId,
    });
  } catch (error) {
    console.error("Error creating ride type:", error);
    res.status(500).json({ error: error.message });
  }
};

const updateRideType = async (req, res) => {
  try {
    const id = req.params.id;
    const affected = await rideTypeModel.updateRideType(id, req.body);
    if (affected === 0) {
      return res.status(404).json({ message: "Ride type not found" });
    }
    res.json({ message: "Ride type updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAllRideTypes = async (req, res) => {
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
    const { ride_type_id } = req.params;

    const deleted = await rideTypeModel.deleteRideType(ride_type_id);

    if (deleted === 0) {
      return res.status(404).json({ message: "Ride type not found" });
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
