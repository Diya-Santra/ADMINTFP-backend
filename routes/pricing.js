const express = require("express");

const { verifyAuth, requireRole } = require("../middleware/auth.middleware");
const {
  list,
  lookup,
  history,
  createPrice,
  changePrice,
  deleteNotAllowed,
} = require("../controllers/pricing.controller");

const router = express.Router();

router.use(verifyAuth, requireRole("Admin"));

router.get("/", list);
router.get("/lookup", lookup);
router.get("/:packType/:packId/history", history);
router.post("/:packType/:packId/prices", createPrice);
router.post("/:packType/:packId/prices/:priceId/change", changePrice);
router.delete("/:packType/:packId/prices/:priceId", deleteNotAllowed);

module.exports = router;
