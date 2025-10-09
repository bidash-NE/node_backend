// controllers/adminCollaboratorController.js
const Collab = require("../models/adminCollaboratorModel");
const { addLog } = require("../models/adminLogModel");

/* ───────── Helper: Create readable log message ───────── */
function formatLog(action, table, recordId, fields) {
  const formatted = Object.entries(fields)
    .map(([k, v]) => `${k}="${v ?? "(null)"}"`)
    .join(", ");
  return `${action} ${table}: id=${recordId} (${formatted})`;
}

/* ───────── CREATE ───────── */
exports.create = async (req, res) => {
  try {
    const { user_id, admin_name } = req.admin;
    const payload = req.body || {};

    if (
      await Collab.existsByEmailOrCid(payload.email, payload.cid ?? "", null)
    ) {
      return res
        .status(409)
        .json({ success: false, error: "Email or CID already exists" });
    }

    const data = await Collab.create(payload);

    const fields = {
      full_name: data.full_name,
      contact: data.contact,
      email: data.email,
      service: data.service,
      role: data.role,
    };

    await addLog({
      user_id,
      admin_name,
      activity: formatLog(
        "CREATE",
        "admin_collaborators",
        data.collaborator_id,
        fields
      ),
    });

    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ───────── READ LIST ───────── */
exports.list = async (req, res) => {
  try {
    const data = await Collab.list(req.query);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ───────── READ ONE ───────── */
exports.getOne = async (req, res) => {
  try {
    const data = await Collab.findById(req.params.id);
    if (!data)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ───────── UPDATE ───────── */
exports.update = async (req, res) => {
  try {
    const { user_id, admin_name } = req.admin;
    const id = req.params.id;
    const before = await Collab.findById(id);
    if (!before)
      return res.status(404).json({ success: false, error: "Not found" });

    const { email, cid } = req.body || {};
    if ((email && email !== before.email) || (cid && cid !== before.cid)) {
      if (await Collab.existsByEmailOrCid(email || "", cid || "", id)) {
        return res
          .status(409)
          .json({ success: false, error: "Email or CID already exists" });
      }
    }

    const after = await Collab.updateById(id, req.body || {});

    // Detect changed fields for logging
    const changes = {};
    for (const k of [
      "full_name",
      "contact",
      "email",
      "service",
      "role",
      "current_address",
      "cid",
    ]) {
      const oldVal = before[k];
      const newVal = after[k];
      if (oldVal === newVal) changes[k] = "(unchanged)";
      else changes[k] = newVal ?? "(null)";
    }

    await addLog({
      user_id,
      admin_name,
      activity: formatLog("UPDATE", "admin_collaborators", id, changes),
    });

    res.json({ success: true, data: after });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ───────── DELETE ───────── */
exports.remove = async (req, res) => {
  try {
    const { user_id, admin_name } = req.admin;
    const id = req.params.id;
    const before = await Collab.findById(id);
    if (!before)
      return res.status(404).json({ success: false, error: "Not found" });

    await Collab.removeById(id);

    const fields = {
      full_name: before.full_name,
      contact: before.contact,
      email: before.email,
      service: before.service,
      role: before.role,
    };

    await addLog({
      user_id,
      admin_name,
      activity: formatLog("DELETE", "admin_collaborators", id, fields),
    });

    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
