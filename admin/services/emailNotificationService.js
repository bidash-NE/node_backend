const nodemailer = require("nodemailer");
const db = require("../config/db");

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

const FROM_ADDRESS =
  (SMTP_FROM && SMTP_FROM.trim()) || (SMTP_USER && SMTP_USER.trim()) || null;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false }, // allow self-signed certs
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send notification emails grouped by 5, one-by-one per group.
 */
async function sendNotificationEmails({
  notificationId,
  title,
  message,
  roles,
}) {
  if (!roles || !roles.length) return { sent: 0, failed: 0 };

  const placeholders = roles.map(() => "?").join(",");
  const sql = `
    SELECT user_id, user_name, email
    FROM users
    WHERE role IN (${placeholders})
      AND email IS NOT NULL
      AND email <> ""
  `;
  const [users] = await db.query(sql, roles);

  if (!users.length) {
    console.log(`[email] No users found for roles [${roles.join(", ")}]`);
    return { sent: 0, failed: 0 };
  }

  console.log(
    `[email] Sending notification #${notificationId} to ${users.length} recipients (5 per batch)`
  );

  const chunkSize = 5;
  const perEmailDelay = 1000; // 1s between individual sends
  const perChunkDelay = 30000; // 30s pause between chunks

  const from = FROM_ADDRESS || SMTP_USER;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i += chunkSize) {
    const chunk = users.slice(i, i + chunkSize);
    console.log(`[email] Processing batch ${Math.floor(i / chunkSize) + 1}`);

    for (const user of chunk) {
      const to = user.email;
      const name = user.user_name || "User";

      const mailOptions = {
        from,
        to,
        subject: title,
        text: message,
        html: `
          <p>Dear ${name},</p>
          <p>${message}</p>
          <p style="margin-top:16px;">Best regards,<br/>SuperApp Team</p>
        `,
        envelope: { from, to: [to] },
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        sent++;
        console.log(`[email] ✅ Sent to ${to} (${info.response})`);
      } catch (err) {
        failed++;
        console.error(`[email] ❌ Failed to ${to}: ${err.message}`);

        // if the SMTP server says "too much mail", stop this run
        if (err.message && err.message.includes("too much mail")) {
          console.error("[email] 🚫 Rate limit hit. Stopping further sends.");
          return { sent, failed };
        }
      }

      await sleep(perEmailDelay);
    }

    // pause between batches
    if (i + chunkSize < users.length) {
      console.log(
        `[email] Batch ${Math.floor(i / chunkSize) + 1} done. Waiting ${
          perChunkDelay / 1000
        }s before next...`
      );
      await sleep(perChunkDelay);
    }
  }

  console.log(
    `[email] Notification #${notificationId} finished: sent=${sent}, failed=${failed}`
  );

  return { sent, failed };
}

/** Simple single test email (optional) */
async function sendTestEmail({ to, subject, message }) {
  const from = FROM_ADDRESS || SMTP_USER;

  const mailOptions = {
    from,
    to,
    subject,
    text: message,
    html: `<p>${message}</p><p>– SuperApp Team</p>`,
    envelope: { from, to: [to] },
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`[email-test] Sent to ${to}: ${info.response}`);
  return info;
}

module.exports = { sendNotificationEmails, sendTestEmail };
