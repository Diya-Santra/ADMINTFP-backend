const express = require("express");

const { verifyAuth, requireRole } = require("../middleware/auth.middleware");
const {
  list,
  getOne,
  create,
  update,
  setActive,
  deleteNotAllowed,
} = require("../controllers/caseStatus.controller");

const router = express.Router();

router.use(verifyAuth, requireRole("Admin"));

router.get("/", list);
router.post("/", create);
router.get("/:id", getOne);
router.patch("/:id", update);
router.patch("/:id/active", setActive);
router.delete("/:id", deleteNotAllowed);

module.exports = router;
