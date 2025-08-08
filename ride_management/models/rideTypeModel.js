const db = require("../config/db");

const createRideType = async ({ name, base_fare, per_km, per_min }) => {
  const checkSql = `SELECT * FROM ride_types WHERE name = ?`;
  const [existing] = await db.query(checkSql, [name]);

  if (existing.length > 0) {
    return { exists: true };
  }

  const insertSql = `
    INSERT INTO ride_types (name, base_fare, per_km, per_min)
    VALUES (?, ?, ?, ?)
  `;
  const [result] = await db.query(insertSql, [
    name,
    base_fare,
    per_km,
    per_min,
  ]);

  return { created: true, insertId: result.insertId };
};

const updateRideType = async (id, data) => {
  const { name, base_fare, per_km, per_min } = data;
  const sql = `
    UPDATE ride_types 
    SET name = ?, base_fare = ?, per_km = ?, per_min = ?
    WHERE ride_type_id = ?
  `;
  const [result] = await db.query(sql, [name, base_fare, per_km, per_min, id]);
  return result.affectedRows;
};

const getRideTypes = async () => {
  const sql = `SELECT * FROM ride_types`;
  const [rows] = await db.query(sql);
  return rows;
};

const getRideTypeById = async (id) => {
  const sql = `SELECT * FROM ride_types WHERE ride_type_id = ?`;
  const [rows] = await db.query(sql, [id]);
  return rows[0];
};
const deleteRideType = async (ride_type_id) => {
  const [result] = await db.query(
    "DELETE FROM ride_types WHERE ride_type_id = ?",
    [ride_type_id]
  );
  return result.affectedRows;
};
module.exports = {
  createRideType,
  updateRideType,
  getRideTypes,
  getRideTypeById,
  deleteRideType,
};
