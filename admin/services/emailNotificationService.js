// services/emailNotificationService.js
const nodemailer = require("nodemailer");
const db = require("../config/db");

const {
  SMTP_HOST = "",
  SMTP_PORT = "587",
  SMTP_USER = "",
  SMTP_PASS = "",
  SMTP_FROM = "",
  SMTP_INSECURE_TLS = "false",
  EMAIL_CONCURRENCY = "10", // ✅ tune this (10–20 recommended for Gmail)
} = process.env;

const host = String(SMTP_HOST).trim();
const port = Number(String(SMTP_PORT).trim() || 587);
const user = String(SMTP_USER).trim();
const pass = String(SMTP_PASS).trim();
const from =
  (SMTP_FROM && String(SMTP_FROM).trim()) || (user ? `TabDhey <${user}>` : "");

const insecureTls = ["true", "1", "yes", "y"].includes(
  String(SMTP_INSECURE_TLS).trim().toLowerCase()
);

const isConfigured = Boolean(host && user && pass);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      requireTLS: port === 587,
      pool: true, // ✅ reuse connections
      maxConnections: 5, // ✅ keep small for Gmail
      maxMessages: Infinity,
      ...(insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
      logger: false,
      debug: false,
    })
  : null;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Fast email sending:
 * - Role-based: pass roles: [...]
 * - Single/Custom recipients: pass recipients: ["a@b.com", "c@d.com"]
 */
async function sendNotificationEmails({
  notificationId,
  title,
  message,
  roles,
  recipients, // ✅ NEW (optional)
}) {
  const safeTitle = String(title || "System Notification").trim();
  const safeMessage = String(message || "").trim();
  const subject = `TabDhey Notification: ${safeTitle}`;

  if (!isConfigured || !transporter) {
    throw new Error(
      "SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)"
    );
  }

  // ✅ Build recipient list either from explicit recipients OR roles lookup
  let users = [];

  if (Array.isArray(recipients) && recipients.length > 0) {
    // normalize + unique
    const uniq = Array.from(
      new Set(
        recipients
          .map((e) =>
            String(e || "")
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      )
    );

    users = uniq.map((email, i) => ({
      user_id: null,
      user_name: "Valued User",
      email,
      _idx: i,
    }));
  } else {
    if (!Array.isArray(roles) || roles.length === 0) {
      return { sent: 0, failed: 0, skipped: 0, total: 0, failures: [] };
    }

    const placeholders = roles.map(() => "?").join(",");
    const sql = `
      SELECT user_id, user_name, email
      FROM users
      WHERE role IN (${placeholders})
        AND email IS NOT NULL
        AND TRIM(email) <> ""
    `;

    const [dbUsers] = await db.query(
      sql,
      roles.map((r) => String(r).trim())
    );

    if (!dbUsers.length) {
      return { sent: 0, failed: 0, skipped: 0, total: 0, failures: [] };
    }

    users = dbUsers;
  }

  const concurrency = Math.max(
    1,
    Math.min(30, Number(EMAIL_CONCURRENCY) || 10)
  );

  // build jobs
  const jobs = users.map((u) => async () => {
    const to = String(u.email || "")
      .trim()
      .toLowerCase();
    const name = String(u.user_name || "Valued User").trim();

    if (!isValidEmail(to)) {
      return {
        status: "skipped",
        user_id: u.user_id ?? null,
        email: to,
        reason: "Invalid email",
      };
    }

    const text = `
Dear ${name},

${safeTitle}

${safeMessage}

This is an automated message from TabDhey Admin.
Everything at your door step!
TabDhey
`.trim();

    const html = `
<div style="font-family: Arial, sans-serif; line-height: 1.6;">
  <p>Dear ${escapeHtml(name)},</p>
  <h3 style="margin:0 0 8px 0;">${escapeHtml(safeTitle)}</h3>
  <p style="white-space: pre-line;">${escapeHtml(safeMessage)}</p>
  <hr />
  <p style="font-size:12px;color:#777;">This is an automated message from TabDhey Admin.</p>
  <p><b>Everything at your door step!</b><br/>TabDhey</p>
</div>
`.trim();

    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
        envelope: { from, to: [to] },
        headers: notificationId
          ? { "X-Notification-Id": String(notificationId) }
          : undefined,
      });

      if (!info?.accepted || info.accepted.length === 0) {
        return {
          status: "failed",
          user_id: u.user_id ?? null,
          email: to,
          reason: "SMTP did not accept recipient",
        };
      }

      return { status: "sent", user_id: u.user_id ?? null, email: to };
    } catch (e) {
      return {
        status: "failed",
        user_id: u.user_id ?? null,
        email: to,
        reason: e?.message || String(e),
      };
    }
  });

  // concurrency runner
  let idx = 0;
  const results = [];

  const workers = Array.from({
    length: Math.min(concurrency, jobs.length),
  }).map(async () => {
    while (idx < jobs.length) {
      const cur = idx++;
      results.push(await jobs[cur]());
    }
  });

  await Promise.all(workers);

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  const failures = results
    .filter((r) => r.status === "failed")
    .slice(0, 20)
    .map(({ user_id, email, reason }) => ({ user_id, email, reason }));

  return { sent, failed, skipped, total: users.length, failures };
}

module.exports = { sendNotificationEmails };
