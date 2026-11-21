const crypto = require("crypto");
const { getPool } = require("../config/db");

// Audit actions written to system_log for staff accounts (table_name = 's_user').
const ACTIONS = {
  PASSWORD_RESET: "PASSWORD_RESET",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
};

const MAX_REASON = 500;
const MIN_PASSWORD = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything after 72 bytes

// SQL that bcrypt-hashes a parameter inside the database (pgcrypto). Same
// format and cost ($2a$10$) as the existing hashes, so login keeps working.
const hashSql = (param) => `extensions.crypt(${param}, extensions.gen_salt('bf', 10))`;

const httpError = (statusCode, error, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.error = error;
  return err;
};

const pool = () => {
  const p = getPool();
  if (!p) throw httpError(503, "DB_UNAVAILABLE", "Database is not connected");
  return p;
};

const withTransaction = async (fn) => {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const parseUserId = (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw httpError(400, "VALIDATION_ERROR", "User id must be a positive integer");
  }
  return n;
};

const parseReason = (reason) => {
  if (reason === undefined || reason === null || reason === "") return null;
  if (typeof reason !== "string") {
    throw httpError(400, "VALIDATION_ERROR", "Reason must be a string");
  }
  const clean = reason.trim();
  if (clean.length > MAX_REASON) {
    throw httpError(400, "VALIDATION_ERROR", `Reason must be at most ${MAX_REASON} characters`);
  }
  return clean || null;
};

const validateNewPassword = (password) => {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw httpError(
      400,
      "VALIDATION_ERROR",
      `New password must be at least ${MIN_PASSWORD} characters`,
    );
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw httpError(400, "VALIDATION_ERROR", "New password is too long (max 72 bytes)");
  }
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) {
    throw httpError(
      400,
      "VALIDATION_ERROR",
      "New password must contain at least one letter and one number",
    );
  }
};

// 12 characters from a set without look-alikes (0/O, 1/l/I), always with
// upper, lower and a digit. crypto.randomInt is cryptographically secure.
const TEMP_CHARS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnpqrstuvwxyz",
  digit: "23456789",
};
const ALL_TEMP_CHARS = TEMP_CHARS.upper + TEMP_CHARS.lower + TEMP_CHARS.digit;

const generateTempPassword = (length = 12) => {
  for (;;) {
    let out = "";
    for (let i = 0; i < length; i++) {
      out += ALL_TEMP_CHARS[crypto.randomInt(ALL_TEMP_CHARS.length)];
    }
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /\d/.test(out)) return out;
  }
};

// One audit row per action. Never pass a password (plain or hashed) here.
const writeUserAuditLog = (
  client,
  { performedBy, userId, actionType, fieldChanged, oldValue = null, newValue = null, reason = null, ipAddress = null },
) =>
  client.query(
    `INSERT INTO system_log
       (performed_by, table_name, record_id, action_type, field_changed,
        old_value, new_value, reason, ip_address)
     VALUES ($1, 's_user', $2, $3, $4, $5, $6, $7, $8)`,
    [
      String(performedBy).slice(0, 100),
      userId,
      actionType,
      fieldChanged,
      oldValue,
      newValue,
      reason,
      ipAddress ? String(ipAddress).slice(0, 45) : null,
    ],
  );

module.exports = {
  ACTIONS,
  hashSql,
  httpError,
  pool,
  withTransaction,
  parseUserId,
  parseReason,
  validateNewPassword,
  generateTempPassword,
  writeUserAuditLog,
};
