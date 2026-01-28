import express from "express";
import { withConn } from "../db/mysql.js";

export const getDeliveryRideId = express.Router();

getDeliveryRideId.get("/ride", async (req, res) => {
  const delivery_batch_id = req.query.delivery_batch_id;

  if (!delivery_batch_id) {
    return res.status(400).json({ message: "delivery_batch_id required" });
  }

  try {
    const result = await withConn(async (conn) => {
      const [rows] = await conn.query(
        `
        SELECT DISTINCT delivery_ride_id
        FROM orders
        WHERE delivery_batch_id = ?
          AND delivery_ride_id IS NOT NULL
        LIMIT 1
        `,
        [delivery_batch_id]
      );

      const row = rows?.[0];
      if (!row?.delivery_ride_id) {
        return {
          status: 404,
          body: { message: "delivery_ride_id not found for this delivery_batch_id" },
        };
      }

      return {
        status: 200,
        body: {
          ok: true,
          delivery_batch_id: String(delivery_batch_id),
          delivery_ride_id: String(row.delivery_ride_id),
        },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("[GET /ride] error:", e?.message || e);
    return res.status(500).json({ message: "Server error" });
  }
});
