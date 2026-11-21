const {
  listNeedsReassigningService,
  resetPasswordService,
  deactivateUserService,
} = require("../services/user.services");

// Who made the change, stored in updated_by / discontinued_by / system_log.
const actorOf = (req) => req.user.email || String(req.user.userId);

// Turn service errors carrying a statusCode into JSON; pass the rest on.
const handle = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req, res);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.error,
        message: error.message,
      });
    }
    return next(error);
  }
};

const needsReassigning = handle((req) =>
  listNeedsReassigningService({ userId: req.query.userId }),
);

const resetPassword = handle((req, res) => {
  // The response carries a temporary password: never cache it.
  res.set("Cache-Control", "no-store");
  return resetPasswordService(req.params.id, req.body || {}, actorOf(req), req.ip);
});

const deactivate = handle((req) =>
  deactivateUserService(req.params.id, req.body || {}, actorOf(req), req.ip),
);

module.exports = { needsReassigning, resetPassword, deactivate };
