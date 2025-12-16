import dotenv from "dotenv";
dotenv.config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  apiKeys: {
    master: process.env.API_KEY || "",
    otp: process.env.API_KEY_OTP || "",
    marketing: process.env.API_KEY_MARKETING || "",
    system: process.env.API_KEY_SYSTEM || "",
  },

  smpp: {
    host: must("SMPP_HOST"),
    port: Number(must("SMPP_PORT")),
    systemId: must("SMPP_SYSTEM_ID"),
    password: must("SMPP_PASSWORD"),
    systemType: process.env.SMPP_SYSTEM_TYPE || "",
    interfaceVersion: Number(process.env.SMPP_INTERFACE_VERSION || 52),
    enquireLinkMs: Number(process.env.ENQUIRE_LINK_MS || 30000),
    reconnectMs: Number(process.env.RECONNECT_MS || 5000),
    maxMps: Number(process.env.MAX_MPS || 10),
    defaultSenderId: process.env.DEFAULT_SENDER_ID || "NEWEDGE",
  },

  mysql: {
    host: must("MYSQL_HOST"),
    port: Number(process.env.MYSQL_PORT || 3306),
    user: must("MYSQL_USER"),
    password: must("MYSQL_PASSWORD"),
    database: must("MYSQL_DATABASE"),
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  },
};
