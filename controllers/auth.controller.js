const { loginService } = require("../services/auth.services");

const login = async (req, res, next) => {
  try {
    const { token, user } = await loginService(req.body || {});

    return res.status(200).json({
      success: true,
      token,
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
    },
  });
};

module.exports = { login, verify };
