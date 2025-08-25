// merchant/models/bannerModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

/* helpers */
const bhutanNow = () => moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function toBizId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("business_id must be a positive integer");
  return n;
}

async function assertBusinessExists(business_id) {
  const [r] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error(`business_id ${business_id} does not exist`);
}

/* queries */

async function createBanner({
  business_id,
  title,
  description,
  banner_image,
  is_active = 1,
  start_date = null,
  end_date = null,
}) {
  const bid = toBizId(business_id);
  await assertBusinessExists(bid);

  const t = toStrOrNull(title);
  const d = toStrOrNull(description);
  const img = toStrOrNull(banner_image);
  if (!img) throw new Error("banner_image is required");

  const now = bhutanNow();
  const [res] = await db.query(
    `INSERT INTO business_banners
       (business_id, title, description, banner_image, is_active, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bid,
      t,
      d,
      img,
      Number(is_active) ? 1 : 0,
      start_date || null,
      end_date || null,
      now,
      now,
    ]
  );

  return await getBannerById(res.insertId);
}

async function getBannerById(id) {
  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, created_at, updated_at
       FROM business_banners WHERE id = ?`,
    [id]
  );
  if (!rows.length)
    return { success: false, message: `Banner id ${id} not found.` };
  return { success: true, data: rows[0] };
}

async function listBanners({ business_id, active_only } = {}) {
  const where = [];
  const params = [];

  if (business_id !== undefined) {
    const bid = toBizId(business_id);
    where.push("business_id = ?");
    params.push(bid);
  }

  if (
    String(active_only).toLowerCase() === "true" ||
    Number(active_only) === 1
  ) {
    where.push(`is_active = 1`);
    where.push(`(start_date IS NULL OR NOW() >= start_date)`);
    where.push(`(end_date IS NULL OR NOW() <= end_date)`);
  }

  const sql = `
    SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, created_at, updated_at
      FROM business_banners
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC
  `;
  const [rows] = await db.query(sql, params);
  return { success: true, data: rows };
}

async function listActiveBannersForBusiness(business_id) {
  const bid = toBizId(business_id);
  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, created_at, updated_at
       FROM business_banners
      WHERE business_id = ?
        AND is_active = 1
        AND (start_date IS NULL OR NOW() >= start_date)
        AND (end_date   IS NULL OR NOW() <= end_date)
      ORDER BY created_at DESC`,
    [bid]
  );
  return { success: true, data: rows };
}

async function updateBanner(id, fields) {
  const prev = await getBannerById(id);
  if (!prev.success) return prev;

  const sets = [];
  const params = [];

  if ("business_id" in fields) {
    const bid = toBizId(fields.business_id);
    await assertBusinessExists(bid);
    sets.push("business_id = ?");
    params.push(bid);
  }
  if ("title" in fields) {
    sets.push("title = ?");
    params.push(toStrOrNull(fields.title));
  }
  if ("description" in fields) {
    sets.push("description = ?");
    params.push(toStrOrNull(fields.description));
  }
  if ("banner_image" in fields) {
    sets.push("banner_image = ?");
    params.push(toStrOrNull(fields.banner_image));
  }
  if ("is_active" in fields) {
    sets.push("is_active = ?");
    params.push(Number(fields.is_active) ? 1 : 0);
  }
  if ("start_date" in fields) {
    sets.push("start_date = ?");
    params.push(fields.start_date || null);
  }
  if ("end_date" in fields) {
    sets.push("end_date = ?");
    params.push(fields.end_date || null);
  }

  if (!sets.length) {
    return {
      success: true,
      message: "No changes.",
      data: prev.data,
      old_image: prev.data.banner_image,
      new_image: prev.data.banner_image,
    };
  }

  sets.push("updated_at = ?");
  params.push(bhutanNow(), id);

  await db.query(
    `UPDATE business_banners SET ${sets.join(", ")} WHERE id = ?`,
    params
  );

  const nowRow = await getBannerById(id);
  return {
    success: true,
    message: "Banner updated successfully.",
    data: nowRow.data,
    old_image: prev.data.banner_image,
    new_image: nowRow.data.banner_image,
  };
}

async function deleteBanner(id) {
  const prev = await getBannerById(id);
  if (!prev.success) return prev;
  await db.query(`DELETE FROM business_banners WHERE id = ?`, [id]);
  return {
    success: true,
    message: "Banner deleted successfully.",
    old_image: prev.data.banner_image || null,
  };
}

module.exports = {
  createBanner,
  getBannerById,
  listBanners,
  listActiveBannersForBusiness,
  updateBanner,
  deleteBanner,
};
