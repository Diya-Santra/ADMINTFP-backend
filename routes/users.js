const express = require("express");

const { verifyAuth, requireRole } = require("../middleware/auth.middleware");
const {
  needsReassigning,
  resetPassword,
  deactivate,
} = require("../controllers/user.controller");

const router = express.Router();

router.use(verifyAuth, requireRole("Admin"));

router.get("/needs-reassigning", needsReassigning);
router.post("/:id/reset-password", resetPassword);
router.patch("/:id/deactivate", deactivate);

module.exports = router;
