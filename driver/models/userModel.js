const pool = require("../config/db");

const insertUser = async (user) => {
  const { user_name, email, phone, password, role } = user;
  const [result] = await pool.query(
    `INSERT INTO users (user_name, email, phone, password_hash, is_verified) VALUES (?, ?, ?, ?, ?)`,
    [user_name, email, phone, password, 0]
  );
  return result.insertId;
};

module.exports = { insertUser };
