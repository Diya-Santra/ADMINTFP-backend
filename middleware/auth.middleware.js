const {
  decodeTokenService,
  getActiveUserService,
  mustChangePasswordService,
} = require("../services/auth.services");

// `allowPendingPasswordChange`: let through a user whose password was reset
// and not yet changed. Only change-password and verify use this; every other
// route answers 403 PASSWORD_CHANGE_REQUIRED until they change it.
const authenticate = (allowPendingPasswordChange) => async (req, res, next) => {
  const match = /^Bearer\s+(\S+)\s*$/.exec(req.headers.authorization || "");

  if (!match) {
    return res.status(401).json({
      success: false,
      error: "UNAUTHORIZED",
      message: "Bearer token required",
    });
  }

  const payload = decodeTokenService(match[1]);

  if (!payload || payload.type === "customer" || !payload.userId) {
    return res.status(401).json({
      success: false,
      error: "INVALID_TOKEN",
      message: "Invalid or expired token",
    });
  }

  try {
    const user = await getActiveUserService(payload.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "INVALID_TOKEN",
        message: "Invalid or expired token",
      });
    }

    const mustChangePassword = await mustChangePasswordService(user.userId);
    req.user = { ...user, mustChangePassword };

    if (mustChangePassword && !allowPendingPasswordChange) {
      return res.status(403).json({
        success: false,
        error: "PASSWORD_CHANGE_REQUIRED",
        message: "You must change your temporary password before continuing",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

const verifyAuth = authenticate(false);
const verifyAuthAllowPasswordChange = authenticate(true);

// Use after verifyAuth. Role names come from the `role` table.
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.roleName)) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: "You do not have permission to perform this action",
      });
    }
    return next();
  };

module.exports = { verifyAuth, verifyAuthAllowPasswordChange, requireRole };
