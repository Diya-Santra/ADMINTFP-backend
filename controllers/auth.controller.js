const { loginService, changePasswordService } = require("../services/auth.services");

const login = async (req, res, next) => {
  try {
    const { token, user, mustChangePassword } = await loginService(req.body || {});

    return res.status(200).json({
      success: true,
      token,
      mustChangePassword,
      user,
    });
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

const verify = (req, res) => {
  return res.status(200).json({
    success: true,
    verified: true,
    user: {
      id: req.user.userId,
      email: req.user.email,
      role: req.user.roleName,
      mustChangePassword: req.user.mustChangePassword,
    },
  });
};

const changePassword = async (req, res, next) => {
  try {
    const data = await changePasswordService(
      req.user.userId,
      req.body || {},
      req.user.email || String(req.user.userId),
      req.ip,
    );
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

module.exports = { login, verify, changePassword };
