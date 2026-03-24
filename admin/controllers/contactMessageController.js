const ContactModel = require("../models/contactMessageModel");

/* =======================================================
   CREATE MESSAGE (PUBLIC)
======================================================= */
async function createMessage(req, res) {
  try {
    const { full_name, contact_type, contact_value, user_type, message } =
      req.body;

    if (!full_name || !contact_type || !contact_value || !message) {
      return res.status(400).json({
        ok: false,
        message: "Required fields are missing",
      });
    }

    if (!["email", "phone"].includes(contact_type)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid contact type",
      });
    }

    const id = await ContactModel.createMessage({
      full_name,
      contact_type,
      contact_value,
      user_type,
      message,
    });

    return res.status(201).json({
      ok: true,
      message: "Message submitted successfully",
      data: { id },
    });
  } catch (err) {
    console.error("Create Message Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
}

/* =======================================================
   GET ALL MESSAGES (ADMIN)
======================================================= */
async function getAllMessages(req, res) {
  try {
    const { status, user_type } = req.query;

    const messages = await ContactModel.getAllMessages({
      status,
      user_type,
    });

    return res.json({
      ok: true,
      count: messages.length,
      data: messages,
    });
  } catch (err) {
    console.error("Get Messages Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
}

/* =======================================================
   GET MESSAGE BY ID
======================================================= */
async function getMessageById(req, res) {
  try {
    const { id } = req.params;

    const message = await ContactModel.getMessageById(id);

    if (!message) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    return res.json({
      ok: true,
      data: message,
    });
  } catch (err) {
    console.error("Get Message Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
}

/* =======================================================
   UPDATE STATUS
======================================================= */
async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["new", "read", "replied"].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid status",
      });
    }

    const updated = await ContactModel.updateMessageStatus(id, status);

    if (!updated) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    return res.json({
      ok: true,
      message: "Status updated successfully",
    });
  } catch (err) {
    console.error("Update Status Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
}

/* =======================================================
   DELETE MESSAGE
======================================================= */
async function deleteMessage(req, res) {
  try {
    const { id } = req.params;

    const deleted = await ContactModel.deleteMessage(id);

    if (!deleted) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    return res.json({
      ok: true,
      message: "Message deleted successfully",
    });
  } catch (err) {
    console.error("Delete Message Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
}

module.exports = {
  createMessage,
  getAllMessages,
  getMessageById,
  updateStatus,
  deleteMessage,
};
