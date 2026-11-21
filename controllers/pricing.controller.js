const {
  listPricingService,
  getPricingHistoryService,
  createPriceService,
  changePriceService,
  lookupPriceService,
} = require("../services/pricing.services");

// Who made the change, stored in created_by / updated_by.
const actorOf = (req) => req.user.email || String(req.user.userId);

// Turn service errors carrying a statusCode into JSON; pass the rest on.
const handle = (fn, successCode = 200) => async (req, res, next) => {
  try {
    const data = await fn(req);
    return res.status(successCode).json({ success: true, data });
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

const list = handle((req) => listPricingService({ date: req.query.date }));

const lookup = handle((req) => lookupPriceService(req.query));

const history = handle((req) =>
  getPricingHistoryService(req.params.packType, req.params.packId),
);

const createPrice = handle(
  (req) =>
    createPriceService(req.params.packType, req.params.packId, req.body || {}, actorOf(req)),
  201,
);

const changePrice = handle((req) =>
  changePriceService(
    req.params.packType,
    req.params.packId,
    req.params.priceId,
    req.body || {},
    actorOf(req),
  ),
);

const deleteNotAllowed = (req, res) =>
  res.status(405).json({
    success: false,
    error: "METHOD_NOT_ALLOWED",
    message: "Prices cannot be deleted; change the price instead to keep history",
  });

module.exports = { list, lookup, history, createPrice, changePrice, deleteNotAllowed };
