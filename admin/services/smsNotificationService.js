// services/smsNotificationService.js
const db = require("../config/db");

const SMS_BULK_URL =
  process.env.SMS_BULK_URL || "https://grab.newedge.bt/sms/api/sms/bulk";
const SMS_API_KEY = (process.env.SMS_API_KEY || "").trim();
const SMS_FROM = (process.env.SMS_FROM || "Taabdoe").trim();

const MAX_BULK = Number(process.env.SMS_BULK_MAX || 50); // gateway default cap

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node 18+ has global fetch. If older node, uses node-fetch dynamically.
async function fetchAny(url, opts) {
  if (global.fetch) return global.fetch(url, opts);
  const { default: fetch } = await import("node-fetch");
  return fetch(url, opts);
}

function normalizeBhutanNumberForSms(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const digits = raw.replace(/[^\d]/g, "");

  // 8-digit local -> prefix 975
  if (digits.length === 8) return `975${digits}`;

  // already with country code
  if (digits.length === 11 && digits.startsWith("975")) return digits;

  // otherwise return digits as-is
  return digits || null;
}

/**
 * Fetch phones for roles from users table.
 * Uses ONLY users.phone (as you confirmed).
 */
async function getPhonesForRoles(roles = []) {
  if (!roles.length) return [];

  const placeholders = roles.map(() => "?").join(",");
  const sql = `
    SELECT user_id, user_name, phone
    FROM users
    WHERE role IN (${placeholders})
      AND phone IS NOT NULL
      AND phone <> ""
  `;

  const [rows] = await db.query(sql, roles);

  const phones = [];
  for (const r of rows) {
    const normalized = normalizeBhutanNumberForSms(r.phone);
    if (normalized) phones.push(normalized);
  }

  // remove duplicates
  return Array.from(new Set(phones));
}

/**
 * Send bulk SMS notifications to roles using gateway bulk endpoint.
 * Returns summary { sent, failed, total, batches, rawResponses[] }
 */
async function sendNotificationSmsBulk({ title, message, roles }) {
  if (!Array.isArray(roles) || !roles.length) {
    return { sent: 0, failed: 0, total: 0, batches: 0, rawResponses: [] };
  }

  if (!SMS_API_KEY) {
    throw new Error("SMS_API_KEY is missing in env");
  }

  const phones = await getPhonesForRoles(roles);
  if (!phones.length) {
    return { sent: 0, failed: 0, total: 0, batches: 0, rawResponses: [] };
  }

  // One SMS text
  const text = `${title}\n${message}`;

  let sent = 0;
  let failed = 0;
  let batches = 0;
  const rawResponses = [];

  for (let i = 0; i < phones.length; i += MAX_BULK) {
    const chunk = phones.slice(i, i + MAX_BULK);
    batches++;

    const payload = {
      messages: chunk.map((to) => ({
        to,
        text,
        from: SMS_FROM,
      })),
    };

    const resp = await fetchAny(SMS_BULK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SMS_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    rawResponses.push(bodyText);

    if (!resp.ok) {
      failed += chunk.length;
    } else {
      try {
        const parsed = JSON.parse(bodyText);
        const results = Array.isArray(parsed?.results) ? parsed.results : null;

        if (results) {
          for (const r of results) {
            if (r && r.ok === true) sent++;
            else failed++;
          }
        } else {
          sent += chunk.length;
        }
      } catch (e) {
        sent += chunk.length;
      }
    }

    if (i + MAX_BULK < phones.length) {
      await sleep(500);
    }
  }

  return { sent, failed, total: phones.length, batches, rawResponses };
}

module.exports = { sendNotificationSmsBulk };
