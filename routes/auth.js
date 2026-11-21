const express = require("express");

const { verifyAuthAllowPasswordChange } = require("../middleware/auth.middleware");
const { login, verify, changePassword } = require("../controllers/auth.controller");

const router = express.Router();

router.post("/login", login);
// Both stay usable while a reset password is waiting to be changed.
router.get("/verify", verifyAuthAllowPasswordChange, verify);
router.post("/change-password", verifyAuthAllowPasswordChange, changePassword);

module.exports = router;
