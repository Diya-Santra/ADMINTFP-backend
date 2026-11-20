const {
  listCaseStatusesService,
  getCaseStatusService,
  createCaseStatusService,
  updateCaseStatusService,
  setCaseStatusActiveService,
} = require("../services/caseStatus.services");

// Who made the change, stored in created_by / updated_by / discontinued_by.
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

// ?active=true | false; anything else lists all.
const parseActiveFilter = (value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
};

const list = handle((req) =>
  listCaseStatusesService({ active: parseActiveFilter(req.query.active) }),
);

const getOne = handle((req) => getCaseStatusService(req.params.id));

const create = handle(
  (req) => createCaseStatusService(req.body || {}, actorOf(req)),
  201,
);

const update = handle((req) =>
  updateCaseStatusService(req.params.id, req.body || {}, actorOf(req)),
);

const setActive = handle((req) =>
  setCaseStatusActiveService(req.params.id, req.body || {}, actorOf(req)),
);

const deleteNotAllowed = (req, res) =>
  res.status(405).json({
    success: false,
    error: "METHOD_NOT_ALLOWED",
    message: "Case statuses cannot be deleted; deactivate them instead",
  });

module.exports = { list, getOne, create, update, setActive, deleteNotAllowed };
