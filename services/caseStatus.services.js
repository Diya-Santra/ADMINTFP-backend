const { getPool } = require("../config/db");

// Columns returned to the admin UI. `case_count` counts every case row that
// points at the status (discontinued ones too): old cases still need a name.
const SELECT_STATUS = `
  SELECT cs.status_id, cs.label, cs.status_code, cs.description,
         cs.display_order, cs.step_number, cs.is_terminal, cs.is_active,
         cs.discontinued_by, cs.discontinued_at,
         cs.created_by, cs.creation_timestamp,
         cs.updated_by, cs.updation_timestamp,
         (SELECT COUNT(*)::int FROM b_case b WHERE b.status_id = cs.status_id) AS case_count
    FROM case_status cs`;

const MAX_LABEL = 100;
const MAX_CODE = 100;
const MAX_SMALLINT = 32767;

const statusError = (statusCode, error, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.error = error;
  return err;
};

const pool = () => {
  const p = getPool();
  if (!p) {
    throw statusError(503, "DB_UNAVAILABLE", "Database is not connected");
  }
  return p;
};

const toCaseStatus = (row) => ({
  id: row.status_id,
  label: row.label,
  code: row.status_code,
  description: row.description,
  displayOrder: row.display_order,
  stepNumber: row.step_number,
  isTerminal: row.is_terminal === 1,
  isActive: row.is_active === 1,
  caseCount: row.case_count,
  discontinuedBy: row.discontinued_by,
  discontinuedAt: row.discontinued_at,
  createdBy: row.created_by,
  createdAt: row.creation_timestamp,
  updatedBy: row.updated_by,
  updatedAt: row.updation_timestamp,
});

// ---------- validation ----------

const parseId = (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw statusError(400, "VALIDATION_ERROR", "Status id must be a positive integer");
  }
  return n;
};

const parseLabel = (label) => {
  if (typeof label !== "string" || !label.trim()) {
    throw statusError(400, "VALIDATION_ERROR", "Label is required");
  }
  const clean = label.trim().replace(/\s+/g, " ");
  if (clean.length > MAX_LABEL) {
    throw statusError(400, "VALIDATION_ERROR", `Label must be at most ${MAX_LABEL} characters`);
  }
  return clean;
};

// "Case Closed" -> "case_closed"
const codeFromLabel = (label) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const parseCode = (code, label) => {
  const raw = code === undefined || code === null || code === "" ? codeFromLabel(label) : code;
  if (typeof raw !== "string" || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(raw)) {
    throw statusError(
      400,
      "VALIDATION_ERROR",
      "Code must be lower_snake_case (letters, digits and underscores)",
    );
  }
  if (raw.length > MAX_CODE) {
    throw statusError(400, "VALIDATION_ERROR", `Code must be at most ${MAX_CODE} characters`);
  }
  return raw;
};

const parseDisplayOrder = (value) => {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SMALLINT) {
    throw statusError(
      400,
      "VALIDATION_ERROR",
      `Display order must be an integer between 0 and ${MAX_SMALLINT}`,
    );
  }
  return n;
};

const parseDescription = (value) => {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw statusError(400, "VALIDATION_ERROR", "Description must be a string");
  }
  return value.trim() || null;
};

const parseIsActive = (value) => {
  if (typeof value !== "boolean") {
    throw statusError(400, "VALIDATION_ERROR", "isActive must be true or false");
  }
  return value;
};

// Names are unique ignoring case and surrounding spaces, so "case closed"
// cannot sit next to "Case Closed". The DB constraint is case-sensitive.
const assertLabelFree = async (client, label, exceptId = null) => {
  const { rows } = await client.query(
    `SELECT status_id FROM case_status
      WHERE LOWER(TRIM(label)) = LOWER($1) AND ($2::int IS NULL OR status_id <> $2)
      LIMIT 1`,
    [label, exceptId],
  );
  if (rows.length) {
    throw statusError(409, "DUPLICATE_LABEL", `A case status named "${label}" already exists`);
  }
};

const assertCodeFree = async (client, code) => {
  const { rows } = await client.query(
    "SELECT status_id FROM case_status WHERE LOWER(status_code) = LOWER($1) LIMIT 1",
    [code],
  );
  if (rows.length) {
    throw statusError(409, "DUPLICATE_CODE", `A case status with code "${code}" already exists`);
  }
};

// Unique-violation race (two admins saving the same name at once).
const mapUniqueViolation = (err) => {
  if (err.code === "23505") {
    if (/status_code/.test(err.constraint || "")) {
      return statusError(409, "DUPLICATE_CODE", "A case status with this code already exists");
    }
    return statusError(409, "DUPLICATE_LABEL", "A case status with this name already exists");
  }
  return err;
};

const withTransaction = async (fn) => {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw mapUniqueViolation(err);
  } finally {
    client.release();
  }
};

const fetchOne = async (client, id) => {
  const { rows } = await client.query(`${SELECT_STATUS} WHERE cs.status_id = $1`, [id]);
  if (!rows.length) {
    throw statusError(404, "NOT_FOUND", `Case status ${id} not found`);
  }
  return toCaseStatus(rows[0]);
};

// Lock the row so a concurrent edit or a new case (whose FK check takes a
// KEY SHARE lock on it) waits for us.
const lockOne = async (client, id) => {
  const { rows } = await client.query(
    "SELECT status_id, is_active FROM case_status WHERE status_id = $1 FOR UPDATE",
    [id],
  );
  if (!rows.length) {
    throw statusError(404, "NOT_FOUND", `Case status ${id} not found`);
  }
  return rows[0];
};

// ---------- services ----------

// `active`: undefined = all, true = active only, false = inactive only.
const listCaseStatusesService = async ({ active } = {}) => {
  const params = [];
  let where = "";
  if (active !== undefined) {
    params.push(active ? 1 : 0);
    where = " WHERE cs.is_active = $1";
  }
  const { rows } = await pool().query(
    `${SELECT_STATUS}${where}
     ORDER BY cs.is_active DESC, cs.display_order ASC NULLS LAST,
              cs.step_number ASC NULLS LAST, cs.status_id ASC`,
    params,
  );
  return rows.map(toCaseStatus);
};

const getCaseStatusService = async (id) => fetchOne(pool(), parseId(id));

const createCaseStatusService = async (body, actor) => {
  const label = parseLabel(body.label);
  const code = parseCode(body.code, label);
  const displayOrder =
    body.displayOrder === undefined ? null : parseDisplayOrder(body.displayOrder);
  const description =
    body.description === undefined ? null : parseDescription(body.description);

  return withTransaction(async (client) => {
    await assertLabelFree(client, label);
    await assertCodeFree(client, code);

    const { rows } = await client.query(
      `INSERT INTO case_status (label, status_code, description, display_order, is_active, created_by)
       VALUES ($1, $2, $3, $4, 1, $5)
       RETURNING status_id`,
      [label, code, description, displayOrder, actor],
    );
    return fetchOne(client, rows[0].status_id);
  });
};

// Rename, change description or display order. The code is the stable key
// other code relies on, so it cannot be changed here.
const updateCaseStatusService = async (id, body, actor) => {
  const statusId = parseId(id);

  if (body.code !== undefined) {
    throw statusError(400, "VALIDATION_ERROR", "Code cannot be changed after creation");
  }
  if (body.isActive !== undefined) {
    throw statusError(
      400,
      "VALIDATION_ERROR",
      "Use PATCH /:id/active to activate or deactivate a status",
    );
  }

  const sets = [];
  const params = [];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  let label;
  if (body.label !== undefined) {
    label = parseLabel(body.label);
    add("label", label);
  }
  if (body.description !== undefined) add("description", parseDescription(body.description));
  if (body.displayOrder !== undefined) add("display_order", parseDisplayOrder(body.displayOrder));

  if (!sets.length) {
    throw statusError(
      400,
      "VALIDATION_ERROR",
      "Nothing to update: send label, description or displayOrder",
    );
  }

  return withTransaction(async (client) => {
    await lockOne(client, statusId);
    if (label !== undefined) await assertLabelFree(client, label, statusId);

    add("updated_by", actor);
    sets.push("updation_timestamp = NOW()");
    params.push(statusId);
    await client.query(
      `UPDATE case_status SET ${sets.join(", ")} WHERE status_id = $${params.length}`,
      params,
    );
    return fetchOne(client, statusId);
  });
};

const setCaseStatusActiveService = async (id, body, actor) => {
  const statusId = parseId(id);
  const isActive = parseIsActive(body.isActive);

  return withTransaction(async (client) => {
    const current = await lockOne(client, statusId);

    if ((current.is_active === 1) === isActive) {
      return fetchOne(client, statusId); // already in that state
    }

    if (!isActive) {
      const { rows } = await client.query(
        "SELECT COUNT(*)::int AS n FROM b_case WHERE status_id = $1",
        [statusId],
      );
      if (rows[0].n > 0) {
        throw statusError(
          409,
          "STATUS_IN_USE",
          `Cannot deactivate: ${rows[0].n} case(s) use this status`,
        );
      }
      await client.query(
        `UPDATE case_status
            SET is_active = 0, discontinued_by = $1, discontinued_at = NOW(),
                updated_by = $1, updation_timestamp = NOW()
          WHERE status_id = $2`,
        [actor, statusId],
      );
    } else {
      await client.query(
        `UPDATE case_status
            SET is_active = 1, discontinued_by = NULL, discontinued_at = NULL,
                updated_by = $1, updation_timestamp = NOW()
          WHERE status_id = $2`,
        [actor, statusId],
      );
    }
    return fetchOne(client, statusId);
  });
};

module.exports = {
  listCaseStatusesService,
  getCaseStatusService,
  createCaseStatusService,
  updateCaseStatusService,
  setCaseStatusActiveService,
};
