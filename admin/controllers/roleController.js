const { prisma } = require("../lib/prisma.js");
const Role = require("../models/roleModel");
const { addLog } = require("../models/adminlogModel");

// ─────────── AUTH HELPER USING BEARER TOKEN ───────────
async function requireAdmin(req) {
  const admin_user_id = req.user?.user_id;

  if (!admin_user_id) {
    const e = new Error("Authentication required");
    e.status = 401;
    throw e;
  }

  const actor = await prisma.users.findFirst({
    where: {
      user_id: Number(admin_user_id),
      role: { in: ["admin", "super admin"] },
    },
    select: { user_id: true, user_name: true, email: true, role: true },
  });

  if (!actor) {
    const e = new Error("Forbidden: Admin or Super Admin required");
    e.status = 403;
    throw e;
  }

  return {
    user_id: Number(actor.user_id),
    admin_name: actor.user_name || actor.email || "ADMIN",
    role: actor.role,
  };
}

function formatLog(action, id, fields) {
  const parts = Object.entries(fields).map(
    ([k, v]) => `${k}="${v ?? "(null)"}"`,
  );
  return `${action} roles: id=${id} (${parts.join(", ")})`;
}

// ─────────── CREATE ───────────
exports.create = async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    const { name, description, self_registrable, is_active } = req.body || {};

    if (!name || !String(name).trim()) {
      return res
        .status(400)
        .json({ success: false, error: "name is required" });
    }

    if (await Role.existsByName(name)) {
      return res
        .status(409)
        .json({ success: false, error: "A role with this name already exists" });
    }

    const data = await Role.create({
      name,
      description,
      self_registrable,
      is_active,
    });

    await addLog({
      user_id: admin.user_id,
      admin_name: admin.admin_name,
      activity: formatLog("CREATE", data.role_id, {
        name: data.name,
        self_registrable: data.self_registrable,
        is_active: data.is_active,
      }),
    });

    res.status(201).json({ success: true, data });
  } catch (err) {
    console.error("Create role error:", err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
};

// ─────────── LIST (PUBLIC - No auth required) ───────────
exports.list = async (_req, res) => {
  try {
    const data = await Role.list();
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error("List roles error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────── GET ONE (PUBLIC - No auth required) ───────────
exports.getOne = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id)
      return res.status(400).json({ success: false, error: "Missing id" });

    const data = await Role.findById(id);
    if (!data)
      return res.status(404).json({ success: false, error: "Not found" });

    res.json({ success: true, data });
  } catch (err) {
    console.error("Get role error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────── UPDATE ───────────
exports.update = async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    const id = req.params.id;
    if (!id)
      return res.status(400).json({ success: false, error: "Missing id" });

    const before = await Role.findById(id);
    if (!before)
      return res.status(404).json({ success: false, error: "Not found" });

    const { name } = req.body || {};
    if (name && Role.normalizeName(name) !== before.name) {
      if (await Role.existsByName(name, id)) {
        return res.status(409).json({
          success: false,
          error: "A role with this name already exists",
        });
      }
    }

    const after = await Role.updateById(id, req.body || {});

    const changes = {};
    for (const k of ["name", "description", "self_registrable", "is_active"]) {
      if (before[k] !== after[k]) changes[k] = after[k] ?? "(null)";
    }

    if (Object.keys(changes).length > 0) {
      await addLog({
        user_id: admin.user_id,
        admin_name: admin.admin_name,
        activity: formatLog("UPDATE", id, changes),
      });
    }

    res.json({ success: true, data: after });
  } catch (err) {
    console.error("Update role error:", err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
};

// ─────────── DELETE ───────────
exports.remove = async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    const id = req.params.id;
    if (!id)
      return res.status(400).json({ success: false, error: "Missing id" });

    const before = await Role.findById(id);
    if (!before)
      return res.status(404).json({ success: false, error: "Not found" });

    const usersWithRole = await Role.countUsersWithRole(before.name);
    if (usersWithRole > 0) {
      return res.status(409).json({
        success: false,
        error: `Cannot delete: ${usersWithRole} account(s) currently use the "${before.name}" role. Deactivate it instead (set is_active to false).`,
      });
    }

    const removed = await Role.removeById(id);
    if (!removed)
      return res.status(404).json({ success: false, error: "Not found" });

    await addLog({
      user_id: admin.user_id,
      admin_name: admin.admin_name,
      activity: formatLog("DELETE", id, { name: before.name }),
    });

    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error("Delete role error:", err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
};
