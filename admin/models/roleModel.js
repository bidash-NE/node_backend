const { prisma } = require("../lib/prisma.js");

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

async function existsByName(name, excludeId = null) {
  const where = { name: normalizeName(name) };

  if (excludeId) {
    where.NOT = { role_id: Number(excludeId) };
  }

  const result = await prisma.roles.findFirst({
    where,
    select: { role_id: true },
  });

  return !!result;
}

async function create(payload = {}) {
  const result = await prisma.roles.create({
    data: {
      name: normalizeName(payload.name),
      description: payload.description || null,
      self_registrable:
        payload.self_registrable !== undefined
          ? Boolean(payload.self_registrable)
          : true,
      is_active:
        payload.is_active !== undefined ? Boolean(payload.is_active) : true,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  return { ...result, role_id: Number(result.role_id) };
}

async function list() {
  const rows = await prisma.roles.findMany({ orderBy: { role_id: "asc" } });
  return rows.map((row) => ({ ...row, role_id: Number(row.role_id) }));
}

async function findById(id) {
  const result = await prisma.roles.findUnique({
    where: { role_id: Number(id) },
  });

  if (!result) return null;

  return { ...result, role_id: Number(result.role_id) };
}

async function updateById(id, changes = {}) {
  const data = {};

  if (changes.name !== undefined) data.name = normalizeName(changes.name);
  if (changes.description !== undefined)
    data.description = changes.description || null;
  if (changes.self_registrable !== undefined)
    data.self_registrable = Boolean(changes.self_registrable);
  if (changes.is_active !== undefined)
    data.is_active = Boolean(changes.is_active);

  if (Object.keys(data).length === 0) return findById(id);

  data.updated_at = new Date();

  const result = await prisma.roles.update({
    where: { role_id: Number(id) },
    data,
  });

  return { ...result, role_id: Number(result.role_id) };
}

async function countUsersWithRole(name) {
  return prisma.users.count({ where: { role: name } });
}

async function removeById(id) {
  try {
    const result = await prisma.roles.delete({
      where: { role_id: Number(id) },
    });
    return { ...result, role_id: Number(result.role_id) };
  } catch (error) {
    if (error.code === "P2025") return null;
    throw error;
  }
}

module.exports = {
  normalizeName,
  existsByName,
  create,
  list,
  findById,
  updateById,
  countUsersWithRole,
  removeById,
};
