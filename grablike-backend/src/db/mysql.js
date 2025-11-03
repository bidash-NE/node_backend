import mysql from "mysql2/promise";
import { env } from "../config/env.js";

export const mysqlPool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: env.MYSQL_PORT,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  connectionLimit: 10,
  timezone: "Z"
});

export async function withConn(fn) {
  const conn = await mysqlPool.getConnection();
  await conn.ping(); // confirm the server responds
  console.log("✅ MySQL connected");
  
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}
