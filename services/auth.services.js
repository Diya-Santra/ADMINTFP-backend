const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { getSupabase } = require("../config/db");
const {
  ACTIONS,
  hashSql,
  withTransaction,
  validateNewPassword,
  writeUserAuditLog,
} = require("./userAccess.helpers");

const JWT_SECRET =
  process.env.JWT_SECRET || "your-super-secret-jwt-key-change-in-production";
const JWT_EXPIRES_IN = "8h";
const CUSTOMER_JWT_EXPIRES_IN = "2h";

const USER_COLUMNS =
  "user_id, email, password_hash, first_name, last_name, user_role_type_id, role(role_name)";

const toAuthUser = (user) => ({
  userId: user.user_id,
  email: user.email,
  roleId: user.user_role_type_id,
  roleName: user.role?.role_name ?? null,
  firstName: user.first_name,
  lastName: user.last_name,
});

const authError = (statusCode, error, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.error = error;
  return err;
};

// Active users only; `filter` narrows the query to one user.
const findActiveUser = async (filter) => {
  const { data, error } = await filter(
    getSupabase()
      .from("s_user")
      .select(USER_COLUMNS)
      .eq("is_active", 1)
      .is("discontinued_at", null),
  ).maybeSingle();

  if (error) throw error;
  return data;
};

// Login
const loginService = async ({ email, password }) => {
  if (!email || !password) {
    throw authError(400, "VALIDATION_ERROR", "Email and password are required");
  }

  // Case-insensitive exact match: escape ilike wildcards (`_` is common in emails).
  const pattern = String(email)
    .trim()
    .replace(/[\\%_]/g, "\\$&");
  const user = await findActiveUser((q) => q.ilike("email", pattern));

  // Same message for unknown, inactive and wrong password: don't reveal which.
  if (
    !user ||
    !user.password_hash ||
    !(await bcrypt.compare(password, user.password_hash))
  ) {
    throw authError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  const token = jwt.sign(
    { userId: user.user_id, roleId: user.user_role_type_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );

  const mustChangePassword = await mustChangePasswordService(user.user_id);

  return {
    token,
    mustChangePassword,
    user: { ...toAuthUser(user), mustChangePassword },
  };
};

// No DB column holds "must change password", so system_log decides: if the
// user's latest password event is a reset (not a change), they must change it.
const mustChangePasswordService = async (userId) => {
  const { data, error } = await getSupabase()
    .from("system_log")
    .select("action_type")
    .eq("table_name", "s_user")
    .eq("record_id", userId)
    .in("action_type", [ACTIONS.PASSWORD_RESET, ACTIONS.PASSWORD_CHANGED])
    .order("log_id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.action_type === ACTIONS.PASSWORD_RESET;
};

// Logged-in user changes their own password (needed after an Admin reset).
// The current password is asked again so an unattended session can't do it.
const changePasswordService = async (
  userId,
  { currentPassword, newPassword } = {},
  actor,
  ipAddress,
) => {
  if (typeof currentPassword !== "string" || !currentPassword) {
    throw authError(400, "VALIDATION_ERROR", "Current password is required");
  }
  validateNewPassword(newPassword);
  if (newPassword === currentPassword) {
    throw authError(400, "VALIDATION_ERROR", "New password must be different from the current one");
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT password_hash FROM s_user
        WHERE user_id = $1 AND is_active = 1 AND discontinued_at IS NULL
        FOR UPDATE`,
      [userId],
    );
    if (!rows.length) {
      throw authError(401, "INVALID_TOKEN", "Invalid or expired token");
    }
    if (!rows[0].password_hash || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      throw authError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
    }

    await client.query(
      `UPDATE s_user
          SET password_hash = ${hashSql("$1")},
              updated_by = $2, updation_timestamp = NOW()
        WHERE user_id = $3`,
      [newPassword, actor, userId],
    );

    await writeUserAuditLog(client, {
      performedBy: actor,
      userId,
      actionType: ACTIONS.PASSWORD_CHANGED,
      fieldChanged: "password_hash",
      ipAddress,
    });

    return { mustChangePassword: false, message: "Password changed successfully" };
  });
};

// Decode a bearer token, or return null if it is invalid or expired
const decodeTokenService = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error("decodeTokenService error:", err.name, err.message);
    return null;
  }
};

// Customer tokens are told apart from staff tokens by `type`; staff auth
// rejects them.
const signCustomerTokenService = (contactIds) =>
  jwt.sign({ type: "customer", contactIds }, JWT_SECRET, {
    expiresIn: CUSTOMER_JWT_EXPIRES_IN,
  });

// Get an active user by id, or null if missing or deactivated
const getActiveUserService = async (userId) => {
  const user = await findActiveUser((q) => q.eq("user_id", userId));
  return user ? toAuthUser(user) : null;
};

module.exports = {
  loginService,
  decodeTokenService,
  getActiveUserService,
  signCustomerTokenService,
  mustChangePasswordService,
  changePasswordService,
};
