const {
  decodeTokenService,
  getActiveUserService,
} = require("../services/auth.services");

const verifyAuth = async (req, res, next) => {
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

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

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

module.exports = { verifyAuth, requireRole };
