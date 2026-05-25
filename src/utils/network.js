/**
 * Network and IP normalization utilities
 */

const getSocketIp = (socketInstance) => {
  const forwarded = socketInstance.handshake?.headers?.["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return socketInstance.handshake?.address || null;
};

const normalizeIp = (ip) => {
  if (!ip) return null;
  let value = String(ip).trim();

  if (value === "::1" || value === "::ffff:127.0.0.1") return "127.0.0.1";

  if (value.startsWith("::ffff:")) {
    value = value.replace("::ffff:", "");
  }

  return value;
};

const getNormalizedSocketIp = (socket) => {
  return normalizeIp(getSocketIp(socket));
};

module.exports = {
  getSocketIp,
  normalizeIp,
  getNormalizedSocketIp,
};
