const express = require("express");

const { verifyAuth } = require("../middleware/auth.middleware");
const { login, verify } = require("../controllers/auth.controller");

const router = express.Router();

router.post("/login", login);
router.get("/verify", verifyAuth, verify);

module.exports = router;
