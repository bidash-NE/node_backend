import express from "express";
import { withConn } from "../db/mysql.js";

export const ridesTypesRouter = express.Router();

// Add ride type
ridesTypesRouter.post("/add-ride-types", async (req, res) => {
  const {
    name,
    code,
    description,
    base_fare,
    per_km_rate,
    per_min_rate,
    min_fare,
    cancellation_fee,
    capacity,
    vehicle_type,
    icon_url,
    is_active = true
  } = req.body;

  try {
    await withConn(async (db) => {
      const [result] = await db.query(
        `INSERT INTO ride_types
        (name, code, description, base_fare, per_km_rate, per_min_rate, min_fare, cancellation_fee, capacity, vehicle_type, icon_url, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          code,
          description,
          base_fare,
          per_km_rate,
          per_min_rate,
          min_fare,
          cancellation_fee,
          capacity,
          vehicle_type,
          icon_url,
          is_active
        ]
      );

      res.status(201).json({
        success: true,
        message: "Ride type added successfully",
        id: result.insertId,
      });
    });
  } catch (err) {
    console.error("Error adding ride type:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get all ride types
ridesTypesRouter.get("/get-ride-types", async (req, res) => {
  try {
    await withConn(async (db) => {
      const [rows] = await db.query(
        "SELECT id, name, code, description, base_fare, per_km_rate, per_min_rate, min_fare, cancellation_fee, capacity, vehicle_type, icon_url, is_active, created_at, updated_at FROM ride_types ORDER BY id DESC"
      );

      res.status(200).json({
        success: true,
        data: rows,
      });
    });
  } catch (err) {
    console.error("Error fetching ride types:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get ride type by user_id (driver's vehicle type)
ridesTypesRouter.get("/get-ride-type/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    await withConn(async (db) => {
      // 1️⃣ Get driver_id from user_id
      const [driverResult] = await db.query(
        "SELECT driver_id FROM drivers WHERE user_id = ?",
        [user_id]
      );

      if (driverResult.length === 0) {
        return res.status(404).json({ success: false, message: "Driver not found" });
      }

      const driver_id = driverResult[0].driver_id;

      // 2️⃣ Now get ride type using driver_id
      const [vehicleRows] = await db.query(
        "SELECT vehicle_type,code FROM driver_vehicles WHERE driver_id = ?",
        [driver_id]
      );

      if (vehicleRows.length === 0) {
        return res.status(404).json({ success: false, message: "Ride type not found" });
      }

      // 3️⃣ Send response
      res.status(200).json({
        success: true,
        data: vehicleRows[0],
      });
    });
  } catch (err) {
    console.error("Error fetching ride type:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ EDIT/UPDATE ride type by ID
ridesTypesRouter.put("/edit-ride-type/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    code,
    description,
    base_fare,
    per_km_rate,
    per_min_rate,
    min_fare,
    cancellation_fee,
    capacity,
    vehicle_type,
    icon_url,
    is_active
  } = req.body;

  try {
    await withConn(async (db) => {
      // First check if ride type exists
      const [existingRide] = await db.query(
        "SELECT id FROM ride_types WHERE id = ?",
        [id]
      );

      if (existingRide.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Ride type not found"
        });
      }

      // Build dynamic update query based on provided fields
      const updateFields = [];
      const updateValues = [];

      if (name !== undefined) {
        updateFields.push("name = ?");
        updateValues.push(name);
      }
      if (code !== undefined) {
        updateFields.push("code = ?");
        updateValues.push(code);
      }
      if (description !== undefined) {
        updateFields.push("description = ?");
        updateValues.push(description);
      }
      if (base_fare !== undefined) {
        updateFields.push("base_fare = ?");
        updateValues.push(base_fare);
      }
      if (per_km_rate !== undefined) {
        updateFields.push("per_km_rate = ?");
        updateValues.push(per_km_rate);
      }
      if (per_min_rate !== undefined) {
        updateFields.push("per_min_rate = ?");
        updateValues.push(per_min_rate);
      }
      if (min_fare !== undefined) {
        updateFields.push("min_fare = ?");
        updateValues.push(min_fare);
      }
      if (cancellation_fee !== undefined) {
        updateFields.push("cancellation_fee = ?");
        updateValues.push(cancellation_fee);
      }
      if (capacity !== undefined) {
        updateFields.push("capacity = ?");
        updateValues.push(capacity);
      }
      if (vehicle_type !== undefined) {
        updateFields.push("vehicle_type = ?");
        updateValues.push(vehicle_type);
      }
      if (icon_url !== undefined) {
        updateFields.push("icon_url = ?");
        updateValues.push(icon_url);
      }
      if (is_active !== undefined) {
        updateFields.push("is_active = ?");
        updateValues.push(is_active);
      }

      // Add updated_at timestamp
      updateFields.push("updated_at = CURRENT_TIMESTAMP");
      
      // Add the ID as the last parameter for WHERE clause
      updateValues.push(id);

      if (updateFields.length === 1) { // Only updated_at was added
        return res.status(400).json({
          success: false,
          message: "No fields to update"
        });
      }

      const query = `UPDATE ride_types SET ${updateFields.join(", ")} WHERE id = ?`;

      const [result] = await db.query(query, updateValues);

      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Ride type not found or no changes made"
        });
      }

      res.status(200).json({
        success: true,
        message: "Ride type updated successfully",
        affectedRows: result.affectedRows
      });
    });
  } catch (err) {
    console.error("Error updating ride type:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: err.message 
    });
  }
});

// ✅ HARD DELETE ride type by ID (Completely remove from database - use with caution)
ridesTypesRouter.delete("/hard-delete-ride-type/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await withConn(async (db) => {
      // First check if ride type exists
      const [existingRide] = await db.query(
        "SELECT id, name, code FROM ride_types WHERE id = ?",
        [id]
      );

      if (existingRide.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Ride type not found"
        });
      }

      // Check if this ride type is being used by any drivers - FIXED COLLATION
      const [driversUsingRideType] = await db.query(
        `SELECT COUNT(*) as driver_count 
         FROM driver_vehicles dv 
         WHERE dv.vehicle_type COLLATE utf8mb4_unicode_ci = ?`,
        [existingRide[0].code]  // Use the code directly instead of subquery
      );

      if (driversUsingRideType[0].driver_count > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot delete ride type. It is currently being used by drivers.",
          driverCount: driversUsingRideType[0].driver_count
        });
      }

      // Perform hard delete
      const [result] = await db.query(
        "DELETE FROM ride_types WHERE id = ?",
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Ride type not found"
        });
      }

      res.status(200).json({
        success: true,
        message: "Ride type permanently deleted",
        deletedRideType: existingRide[0].name
      });
    });
  } catch (err) {
    console.error("Error hard deleting ride type:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: err.message 
    });
  }
});

// ✅ Get ride type by ID (for editing)
ridesTypesRouter.get("/get-ride-type-by-id/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await withConn(async (db) => {
      const [rows] = await db.query(
        "SELECT id, name, code, description, base_fare, per_km_rate, per_min_rate, min_fare, cancellation_fee, capacity, vehicle_type, icon_url, is_active, created_at, updated_at FROM ride_types WHERE id = ?",
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "Ride type not found" 
        });
      }

      res.status(200).json({
        success: true,
        data: rows[0],
      });
    });
  } catch (err) {
    console.error("Error fetching ride type by ID:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});