// controllers/systemNotificationController.js
const {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,

  // ✅ NEW
  getUserContactById,
} = require("../models/systemNotificationModel");

const adminLogModel = require("../models/adminlogModel");
const {
  sendNotificationEmails,
} = require("../services/emailNotificationService");
const {
  sendNotificationSmsBulk,
} = require("../services/smsNotificationService");

/* -------------------- helpers -------------------- */
function validateTitleMessage(title, message) {
  if (!title || !String(title).trim() || !message || !String(message).trim()) {
    return "Title and message are required.";
  }
  return null;
}
function pickActor(body = {}) {
  return {
    createdBy: body.user_id || null,
    adminName: body.user_name || "System",
  };
}

/* ======================================================
   ✅ NEW: Send EMAIL to SINGLE user (fetch email by user_id)
   POST /api/system-notifications/user/email
   body: { user_id?, user_name?, target_user_id, title, message }
====================================================== */
async function sendEmailToSingleUser(req, res) {
  try {
    const { target_user_id, title, message } = req.body || {};
    const { createdBy, adminName } = pickActor(req.body || {});

    if (!target_user_id) {
      return res.status(400).json({
        success: false,
        message: "target_user_id is required.",
      });
    }

    const err = validateTitleMessage(title, message);
    if (err) return res.status(400).json({ success: false, message: err });

    const user = await getUserContactById(target_user_id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Target user not found." });
    }

    const email = String(user.email || "").trim();
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Target user email not found.",
      });
    }

    // ✅ reuse existing group-email function but pass direct list
    const emailSummary = await sendNotificationEmails({
      notificationId: null,
      title: String(title).trim(),
      message: String(message).trim(),
      roles: [], // not used
      recipients: [email], // ✅ NEW support needed in service OR it will be ignored
    });

    await adminLogModel.addLog({
      user_id: createdBy,
      admin_name: adminName,
      activity: `Sent EMAIL (single user) to user_id=${target_user_id} (${email}) — "${String(
        title
      ).trim()}"`,
    });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully.",
      target_user_id: Number(target_user_id),
      email,
      email_summary: emailSummary,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   ✅ NEW: Send SMS to SINGLE user (fetch phone by user_id)
   POST /api/system-notifications/user/sms
   body: { user_id?, user_name?, target_user_id, title, message }
====================================================== */
async function sendSmsToSingleUser(req, res) {
  try {
    const { target_user_id, title, message } = req.body || {};
    const { createdBy, adminName } = pickActor(req.body || {});

    if (!target_user_id) {
      return res.status(400).json({
        success: false,
        message: "target_user_id is required.",
      });
    }

    const err = validateTitleMessage(title, message);
    if (err) return res.status(400).json({ success: false, message: err });

    const user = await getUserContactById(target_user_id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Target user not found." });
    }

    const phone = String(user.phone || "").trim();
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Target user phone number not found.",
      });
    }

    // ✅ reuse existing bulk sms function but pass direct list
    const smsSummary = await sendNotificationSmsBulk({
      title: String(title).trim(),
      message: String(message).trim(),
      roles: [], // not used
      recipients: [phone], // ✅ NEW support needed in service OR it will be ignored
    });

    await adminLogModel.addLog({
      user_id: createdBy,
      admin_name: adminName,
      activity: `Sent SMS (single user) to user_id=${target_user_id} (${phone}) — "${String(
        title
      ).trim()}"`,
    });

    return res.status(200).json({
      success: true,
      message: "SMS sent successfully.",
      target_user_id: Number(target_user_id),
      phone,
      sms_summary: smsSummary,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   EXISTING: Create notification to roles (in_app/email/sms)
====================================================== */
async function createSystemNotification(req, res) {
  try {
    const {
      user_id,
      user_name,
      title,
      message,
      delivery_channels,
      target_audience,
    } = req.body || {};

    const createdBy = user_id || null;
    const adminName = user_name || "System";

    if (
      !title ||
      !String(title).trim() ||
      !message ||
      !String(message).trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required.",
      });
    }

    if (!Array.isArray(delivery_channels) || delivery_channels.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one delivery channel is required.",
      });
    }

    if (!Array.isArray(target_audience) || target_audience.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one target audience is required.",
      });
    }

    const norm = (s) =>
      String(s || "")
        .trim()
        .toLowerCase();
    const lowerChannels = delivery_channels.map(norm);
    const roles = target_audience
      .map((r) => String(r || "").trim())
      .filter(Boolean);

    const wantsInApp = lowerChannels.includes("in_app");
    const wantsEmail = lowerChannels.includes("email");
    const wantsSms = lowerChannels.includes("sms");

    let notificationId = null;
    let emailSummary = null;
    let smsSummary = null;

    if (wantsInApp) {
      notificationId = await insertSystemNotification({
        title: String(title).trim(),
        message: String(message).trim(),
        deliveryChannels: ["in_app"],
        targetAudience: roles,
        createdBy,
      });

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Created IN_APP notification #${notificationId} - "${String(
          title
        ).trim()}" for roles [${roles.join(", ")}]`,
      });
    }

    if (wantsEmail) {
      emailSummary = await sendNotificationEmails({
        notificationId,
        title: String(title).trim(),
        message: String(message).trim(),
        roles,
      });

      const sent = Number(emailSummary?.sent || 0);
      const failed = Number(emailSummary?.failed || 0);
      const skipped = Number(emailSummary?.skipped || 0);
      const total =
        emailSummary?.total != null
          ? Number(emailSummary.total)
          : sent + failed + skipped;

      let logMessage = `Sent EMAIL notification to roles [${roles.join(", ")}]`;
      if (notificationId) logMessage += ` (Notification #${notificationId})`;
      logMessage += ` — total: ${total}, sent: ${sent}, failed: ${failed}, skipped: ${skipped}`;

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: logMessage,
      });
    }

    if (wantsSms) {
      smsSummary = await sendNotificationSmsBulk({
        title: String(title).trim(),
        message: String(message).trim(),
        roles,
      });

      const total = Number(smsSummary?.total || 0);
      const sent = Number(smsSummary?.sent || 0);
      const failed = Number(smsSummary?.failed || 0);
      const batches = Number(smsSummary?.batches || 0);

      let logMessage = `Sent SMS notification to roles [${roles.join(", ")}]`;
      if (notificationId) logMessage += ` (Notification #${notificationId})`;
      logMessage += ` — total: ${total}, sent: ${sent}, failed: ${failed}, batches: ${batches}`;

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: logMessage,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Notification processed successfully.",
      notification_id: notificationId,
      email_summary: emailSummary,
      sms_summary: smsSummary,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   EXISTING: Fetch all notifications (admin)
====================================================== */
async function getAllSystemNotificationsController(req, res) {
  try {
    const notifications = await getAllSystemNotifications();
    return res.json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   EXISTING: Fetch notifications visible to user by role
====================================================== */
async function getSystemNotificationsByUser(req, res) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    const notifications = await getNotificationsForUserRole(userId);

    return res.json({
      success: true,
      user_id: userId,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

module.exports = {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,

  // ✅ NEW exports
  sendSmsToSingleUser,
  sendEmailToSingleUser,
};
