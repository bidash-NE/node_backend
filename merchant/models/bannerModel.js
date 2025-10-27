// models/bannerModel.js
const db = require("../config/db");
const moment = require("moment-timezone");
const axios = require("axios");

const ADMIN_WALLET_ID = "NET000001";
const ID_SERVICE_URL =
  process.env.ID_SERVICE_URL || "https://grab.newedge.bt/wallet"; // e.g., same service or dedicated ids service

const nowBT = () => moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");

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
function norm(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}
function toOwnerType(v) {
  const s = norm(v);
  if (!s) return null;
  if (s !== "food" && s !== "mart")
    throw new Error("owner_type must be either 'food' or 'mart'");
  return s;
}

async function assertBusinessExists(business_id) {
  const [r] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error(`business_id ${business_id} does not exist`);
}

async function getConn() {
  if (typeof db.getConnection === "function") return db.getConnection();
  throw new Error("DB pool does not expose getConnection()");
}

/* ---- helpers to call ID API ---- */
async function getJournalCodeViaApi() {
  const { data } = await axios.post(`${ID_SERVICE_URL}/ids/journal`, {});
  if (!data?.ok || !data.code)
    throw new Error("Failed to get journal_code from ID service");
  return data.code;
}
async function getTwoTxnIdsViaApi() {
  const { data } = await axios.post(`${ID_SERVICE_URL}/ids/transaction`, {
    count: 2,
  });
  if (!data?.ok || !Array.isArray(data.data) || data.data.length < 2)
    throw new Error("Failed to get transaction_ids from ID service");
  return { dr: data.data[0], cr: data.data[1] };
}

/* ---------- AUTO-DEACTIVATION SWEEP ---------- */
async function sweepExpiredBanners() {
  const now = nowBT();
  await db.query(
    `UPDATE business_banners
       SET is_active = 0, updated_at = ?
     WHERE is_active = 1
       AND end_date IS NOT NULL
       AND end_date <= CURRENT_DATE()`,
    [now]
  );
}

/* ---------- Internal insert/select ---------- */
async function _insertBanner(
  conn,
  {
    business_id,
    title,
    description,
    banner_image,
    is_active = 1,
    start_date = null,
    end_date = null,
    owner_type,
  }
) {
  const bid = toBizId(business_id);
  const t = toStrOrNull(title);
  const d = toStrOrNull(description);
  const img = toStrOrNull(banner_image);
  if (!img) throw new Error("banner_image is required");
  const otype = toOwnerType(owner_type);
  if (!otype)
    throw new Error("owner_type is required and must be 'food' or 'mart'");

  const now = nowBT();
  const [res] = await conn.query(
    `INSERT INTO business_banners
       (business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bid,
      t,
      d,
      img,
      Number(is_active) ? 1 : 0,
      start_date || null,
      end_date || null,
      otype,
      now,
      now,
    ]
  );
  return res.insertId;
}

async function _selectBanner(conn, id) {
  const [rows] = await conn.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
       FROM business_banners WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
}

/* ---------- Atomic payment + banner creation (ENUM remark = 'CR'/'DR') ---------- */
async function createBannerWithWalletCharge({ banner, payer_user_id, amount }) {
  await assertBusinessExists(toBizId(banner.business_id));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, message: "Invalid total_amount" };
  }

  const conn = await getConn();
  try {
    await conn.beginTransaction();

    // Lock payer wallet
    const [payerRows] = await conn.query(
      `SELECT id, wallet_id, amount, status FROM wallets WHERE user_id = ? LIMIT 1 FOR UPDATE`,
      [payer_user_id]
    );
    if (!payerRows.length) {
      await conn.rollback();
      conn.release();
      return {
        success: false,
        message: `No wallet found for user_id ${payer_user_id}`,
      };
    }
    const payer = payerRows[0];

    // Lock admin wallet
    const [adminRows] = await conn.query(
      `SELECT id, wallet_id, amount, status FROM wallets WHERE wallet_id = ? LIMIT 1 FOR UPDATE`,
      [ADMIN_WALLET_ID]
    );
    if (!adminRows.length) {
      await conn.rollback();
      conn.release();
      return {
        success: false,
        message: `Admin wallet ${ADMIN_WALLET_ID} not found`,
      };
    }
    const admin = adminRows[0];

    if (payer.status !== "ACTIVE") {
      await conn.rollback();
      conn.release();
      return { success: false, message: "Payer wallet is not ACTIVE" };
    }
    if (admin.status !== "ACTIVE") {
      await conn.rollback();
      conn.release();
      return { success: false, message: "Admin wallet is not ACTIVE" };
    }

    const amt = Number(amount);
    if (Number(payer.amount) < amt) {
      await conn.rollback();
      conn.release();
      return { success: false, message: "Insufficient wallet balance" };
    }

    // Create banner first (so note can include id)
    const bannerId = await _insertBanner(conn, banner);

    // Get IDs from the ID service
    const journal_code = await getJournalCodeViaApi();
    const { dr, cr } = await getTwoTxnIdsViaApi();

    const now = nowBT();
    const note = `Banner Fee | banner_id=${bannerId}`;

    // Update balances
    await conn.query(`UPDATE wallets SET amount = amount - ? WHERE id = ?`, [
      amt,
      payer.id,
    ]);
    await conn.query(`UPDATE wallets SET amount = amount + ? WHERE id = ?`, [
      amt,
      admin.id,
    ]);

    // DR row — out from payer to admin
    await conn.query(
      `INSERT INTO wallet_transactions
        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'DR', ?, ?, ?)`,
      [dr, journal_code, payer.wallet_id, admin.wallet_id, amt, note, now, now]
    );

    // CR row — into admin from payer
    await conn.query(
      `INSERT INTO wallet_transactions
        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CR', ?, ?, ?)`,
      [cr, journal_code, payer.wallet_id, admin.wallet_id, amt, note, now, now]
    );

    await conn.commit();
    const row = await _selectBanner(conn, bannerId);
    conn.release();

    await sweepExpiredBanners();

    return {
      success: true,
      data: row,
      payment: {
        journal_code,
        debited_from_wallet: payer.wallet_id,
        credited_to_wallet: admin.wallet_id,
        amount: amt,
        debit_txn_id: dr,
        credit_txn_id: cr,
      },
    };
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    conn.release();
    return {
      success: false,
      message: err.message || "Failed to create banner with wallet charge",
    };
  }
}

/* ---------- Other banner ops ---------- */
async function getBannerById(id) {
  await sweepExpiredBanners();
  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
       FROM business_banners WHERE id = ?`,
    [id]
  );
  if (!rows.length)
    return { success: false, message: `Banner id ${id} not found.` };
  return { success: true, data: rows[0] };
}
async function listBanners({ business_id, active_only, owner_type } = {}) {
  await sweepExpiredBanners();
  const where = [],
    params = [];
  if (business_id !== undefined) {
    const bid = toBizId(business_id);
    where.push("business_id = ?");
    params.push(bid);
  }
  if (owner_type) {
    const ot = toOwnerType(owner_type);
    where.push("owner_type = ?");
    params.push(ot);
  }
  if (
    String(active_only).toLowerCase() === "true" ||
    Number(active_only) === 1
  ) {
    where.push(
      "is_active = 1",
      "(start_date IS NULL OR CURRENT_DATE() >= start_date)",
      "(end_date IS NULL OR CURRENT_DATE() <= end_date)"
    );
  }
  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
       FROM business_banners ${
         where.length ? "WHERE " + where.join(" AND ") : ""
       } ORDER BY created_at DESC`,
    params
  );
  return { success: true, data: rows };
}
async function listAllBannersForBusiness(business_id, owner_type) {
  await sweepExpiredBanners();
  const bid = toBizId(business_id);
  const where = ["business_id = ?"];
  const params = [bid];
  if (owner_type) {
    const ot = toOwnerType(owner_type);
    where.push("owner_type = ?");
    params.push(ot);
  }
  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
       FROM business_banners WHERE ${where.join(
         " AND "
       )} ORDER BY created_at DESC`,
    params
  );
  return { success: true, data: rows };
}
async function listActiveByKind(owner_type, business_id) {
  await sweepExpiredBanners();
  const where = [
    "is_active = 1",
    "owner_type = ?",
    "(start_date IS NULL OR CURRENT_DATE() >= start_date)",
    "(end_date   IS NULL OR CURRENT_DATE() <= end_date)",
  ];
  const params = [toOwnerType(owner_type)];
  if (business_id !== undefined && business_id !== null) {
    const bid = toBizId(business_id);
    where.push("business_id = ?");
    params.push(bid);
  }
  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
       FROM business_banners WHERE ${where.join(
         " AND "
       )} ORDER BY created_at DESC`,
    params
  );
  return { success: true, data: rows };
}
async function updateBanner(id, fields) {
  await sweepExpiredBanners();
  const [prev] = await db.query(
    `SELECT banner_image FROM business_banners WHERE id = ?`,
    [id]
  );
  if (!prev.length)
    return { success: false, message: `Banner id ${id} not found.` };

  const sets = [],
    params = [];
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
  if ("owner_type" in fields) {
    sets.push("owner_type = ?");
    params.push(toOwnerType(fields.owner_type));
  }
  if (!sets.length) {
    const [cur] = await db.query(
      `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
         FROM business_banners WHERE id = ?`,
      [id]
    );
    return { success: true, message: "No changes.", data: cur[0] };
  }
  sets.push("updated_at = ?");
  params.push(nowBT(), id);
  await db.query(
    `UPDATE business_banners SET ${sets.join(", ")} WHERE id = ?`,
    params
  );

  const [rows] = await db.query(
    `SELECT id, business_id, title, description, banner_image, is_active, start_date, end_date, owner_type, created_at, updated_at
       FROM business_banners WHERE id = ?`,
    [id]
  );
  return {
    success: true,
    message: "Banner updated successfully.",
    data: rows[0],
  };
}
async function deleteBanner(id) {
  const [prev] = await db.query(
    `SELECT banner_image FROM business_banners WHERE id = ?`,
    [id]
  );
  if (!prev.length)
    return { success: false, message: `Banner id ${id} not found.` };
  await db.query(`DELETE FROM business_banners WHERE id = ?`, [id]);
  return {
    success: true,
    message: "Banner deleted successfully.",
    old_image: prev[0].banner_image || null,
  };
}

module.exports = {
  sweepExpiredBanners,
  createBannerWithWalletCharge,
  getBannerById,
  listBanners,
  listAllBannersForBusiness,
  listActiveByKind,
  updateBanner,
  deleteBanner,
};
