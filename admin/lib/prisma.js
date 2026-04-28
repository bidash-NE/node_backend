// admin/lib/prisma.js
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const { PrismaClient } = require("../../generated/prisma");

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

const prisma = new PrismaClient({ adapter });

module.exports = { prisma };
