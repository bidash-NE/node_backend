// config/mailer.js  ✅ (same behavior, no logs)
const nodemailer = require("nodemailer");

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

const host = (SMTP_HOST || "").trim();
const port = Number((SMTP_PORT || "587").trim());
const user = (SMTP_USER || "").trim();
const pass = (SMTP_PASS || "").trim();
const from =
  (SMTP_FROM && SMTP_FROM.trim()) || (user ? `No-Reply <${user}>` : null);

const isConfigured = Boolean(host && user && pass);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      // ✅ keep your earlier TLS behavior so it continues working
      tls: { rejectUnauthorized: false, servername: host },
      requireTLS: port === 587,
      // ✅ remove logs
      logger: false,
      debug: false,
    })
  : null;

module.exports = { transporter, from, isConfigured };
