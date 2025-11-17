// utils/mailer.js
const nodemailer = require("nodemailer");

function maskWalletId(walletId) {
  if (!walletId.startsWith("NET") || walletId.length < 5) return walletId;

  const prefix = "NET"; // Keep NET
  const last2 = walletId.slice(-2); // Keep last 2 digits
  const maskedMiddle = "*".repeat(walletId.length - prefix.length - 2);

  return prefix + maskedMiddle + last2; // NET*****23
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
});

async function sendOtpEmail({ to, otp, userName, walletId }) {
  const name = userName || "Valued User";
  const maskedWallet = maskWalletId(walletId);

  const disclaimer =
    "Disclaimer: Please do NOT share this OTP or your T-PIN with anyone. " +
    "New Edge Technology Pvt. Ltd. will never ask for your OTP, T-PIN, or password. " +
    "If you did not request a T-PIN reset, please ignore this email immediately.";

  const subject = "Your OTP for Wallet T-PIN Reset";

  const text = `
Dear ${name},

We received a request to reset the T-PIN for your wallet (${maskedWallet}).

Your OTP is: ${otp}

This OTP is valid for 10 minutes and can only be used once.

${disclaimer}

Best Regards,
New Edge Technology Pvt. Ltd.
`.trim();

  const html = `
    <p>Dear ${name},</p>
    <p>We received a request to reset the T-PIN for your wallet: <b>${maskedWallet}</b>.</p>
    <p>Your OTP is:</p>
    <h2 style="letter-spacing:4px;">${otp}</h2>
    <p>This OTP is valid for <b>10 minutes</b> and can only be used once.</p>
    <hr />
    <p style="font-size:12px;color:#777;">${disclaimer}</p>
    <p>Best Regards,<br />New Edge Technology Pvt. Ltd.</p>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendOtpEmail };
