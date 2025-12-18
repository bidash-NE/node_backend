// config/mailer.js
const nodemailer = require("nodemailer");

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

const host = (SMTP_HOST || "").trim();
const port = Number((SMTP_PORT || "587").trim());
const user = (SMTP_USER || "").trim();
const pass = (SMTP_PASS || "").trim(); // ✅ trims accidental spaces in .env
const from = (SMTP_FROM && SMTP_FROM.trim()) || (user ? user : null);

if (!host || !user || !pass) {
  console.warn(
    "[mailer] Missing SMTP config. Check SMTP_HOST/SMTP_USER/SMTP_PASS"
  );
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  tls: { rejectUnauthorized: false, servername: host },
  requireTLS: port === 587,
  logger: true,
  debug: true,
});

// optional: quick check on server start
transporter.verify().then(
  () => console.log("[mailer] SMTP ready"),
  (e) => console.error("[mailer] SMTP verify failed:", e.message)
);

module.exports = { transporter, from };
