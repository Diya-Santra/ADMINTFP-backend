const {
  ACTIONS,
  hashSql,
  httpError,
  pool,
  withTransaction,
  parseUserId,
  parseReason,
  generateTempPassword,
  writeUserAuditLog,
} = require("./userAccess.helpers");

const ADMIN_ROLE = "Admin";

// A user counts as active only with is_active = 1 and no discontinued_at,
// the same rule login and the auth middleware use.
const INACTIVE_SQL = "(u.is_active IS DISTINCT FROM 1 OR u.discontinued_at IS NOT NULL)";

const fullName = (row) =>
  [row.first_name, row.last_name].filter(Boolean).join(" ") || null;

// ---------- needs reassigning ----------

// Open (not terminal, not discontinued) cases and tasks whose assigned person
// is deactivated. A case can show twice if both its CSR and Team Lead left.
// `db` lets deactivate run this inside its own transaction.
const findNeedsReassigning = async (db, userId = null) => {
  const params = [userId];
  const goneUsers = `
    WITH gone AS (
      SELECT u.user_id, u.first_name, u.last_name, u.email, u.discontinued_at
        FROM s_user u
       WHERE ${INACTIVE_SQL} AND ($1::int IS NULL OR u.user_id = $1)
    )`;

  const casesSql = `${goneUsers}
    SELECT c.case_id, c.status_id, cs.label AS status_label, a.assigned_as,
           g.user_id, g.first_name, g.last_name, g.email, g.discontinued_at
      FROM b_case c
      CROSS JOIN LATERAL (VALUES
        ('csr', c.assigned_csr_user_id),
        ('team_lead', c.assigned_team_lead_user_id)
      ) AS a(assigned_as, user_id)
      JOIN gone g ON g.user_id = a.user_id
      LEFT JOIN case_status cs ON cs.status_id = c.status_id
     WHERE c.discontinued_at IS NULL
       AND COALESCE(cs.is_terminal, 0) = 0
     ORDER BY c.case_id, a.assigned_as`;

  const tasksSql = `${goneUsers}
    SELECT t.task_id, t.case_id, t.application_id, t.status, t.description, t.due_by,
           g.user_id, g.first_name, g.last_name, g.email, g.discontinued_at
      FROM task t
      JOIN gone g ON g.user_id = t.assigned_to_user_id
      LEFT JOIN task_status ts ON ts.status_code = t.status
     WHERE t.discontinued_at IS NULL
       AND COALESCE(ts.is_terminal, 0) = 0
     ORDER BY t.task_id`;

  const [cases, tasks] = await Promise.all([
    db.query(casesSql, params),
    db.query(tasksSql, params),
  ]);

  const assignee = (r) => ({
    userId: r.user_id,
    name: fullName(r),
    email: r.email,
    deactivatedAt: r.discontinued_at,
  });

  return {
    cases: cases.rows.map((r) => ({
      caseId: Number(r.case_id),
      statusId: r.status_id,
      statusLabel: r.status_label,
      assignedAs: r.assigned_as,
      assignedTo: assignee(r),
      needsReassigning: true,
    })),
    tasks: tasks.rows.map((r) => ({
      taskId: Number(r.task_id),
      caseId: r.case_id === null ? null : Number(r.case_id),
      applicationId: r.application_id === null ? null : Number(r.application_id),
      status: r.status,
      description: r.description,
      dueBy: r.due_by,
      assignedTo: assignee(r),
      needsReassigning: true,
    })),
  };
};

const listNeedsReassigningService = async ({ userId } = {}) => {
  const id = userId === undefined || userId === "" ? null : parseUserId(userId);
  const { cases, tasks } = await findNeedsReassigning(pool(), id);
  return { counts: { cases: cases.length, tasks: tasks.length }, cases, tasks };
};

// ---------- reset password ----------

// Sets a random temporary password and logs PASSWORD_RESET. The old password
// stops working when this commits. The plain temporary password exists only
// in this response; the DB stores the bcrypt hash.
const resetPasswordService = async (id, body, actor, ipAddress) => {
  const userId = parseUserId(id);
  const reason = parseReason(body.reason);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT u.user_id, u.email, u.first_name, u.last_name, u.is_active, u.discontinued_at
         FROM s_user u WHERE u.user_id = $1 FOR UPDATE`,
      [userId],
    );
    const user = rows[0];
    if (!user) throw httpError(404, "NOT_FOUND", `User ${userId} not found`);
    if (user.is_active !== 1 || user.discontinued_at) {
      throw httpError(409, "USER_INACTIVE", "Cannot reset the password of a deactivated user");
    }

    const temporaryPassword = generateTempPassword();

    await client.query(
      `UPDATE s_user
          SET password_hash = ${hashSql("$1")},
              updated_by = $2, updation_timestamp = NOW()
        WHERE user_id = $3`,
      [temporaryPassword, actor, userId],
    );

    await writeUserAuditLog(client, {
      performedBy: actor,
      userId,
      actionType: ACTIONS.PASSWORD_RESET,
      fieldChanged: "password_hash",
      reason,
      ipAddress,
    });

    return {
      userId,
      email: user.email,
      name: fullName(user),
      temporaryPassword,
      mustChangePassword: true,
      message:
        "Give this temporary password to the user. It is shown only once. " +
        "They must change it at next login.",
    };
  });
};

// ---------- deactivate ----------

// Blocks login at once (login and every request check is_active), keeps the
// record, refuses the last active Admin, and logs USER_DEACTIVATED.
const deactivateUserService = async (id, body, actor, ipAddress) => {
  const userId = parseUserId(id);
  const reason = parseReason(body.reason);

  return withTransaction(async (client) => {
    const { rows: roleRows } = await client.query(
      `SELECT r.role_name FROM s_user u
         LEFT JOIN role r ON r.role_id = u.user_role_type_id
        WHERE u.user_id = $1`,
      [userId],
    );
    if (!roleRows.length) throw httpError(404, "NOT_FOUND", `User ${userId} not found`);
    const isAdmin = roleRows[0].role_name === ADMIN_ROLE;

    // Lock every active Admin in id order before counting, so two Admins
    // deactivating each other at the same moment cannot both succeed.
    let activeAdmins = 0;
    if (isAdmin) {
      const { rows } = await client.query(
        `SELECT u.user_id FROM s_user u
           JOIN role r ON r.role_id = u.user_role_type_id
          WHERE r.role_name = $1 AND u.is_active = 1 AND u.discontinued_at IS NULL
          ORDER BY u.user_id
          FOR UPDATE OF u`,
        [ADMIN_ROLE],
      );
      activeAdmins = rows.length;
    }

    const { rows } = await client.query(
      `SELECT u.user_id, u.email, u.first_name, u.last_name, u.is_active, u.discontinued_at,
              r.role_name
         FROM s_user u
         LEFT JOIN role r ON r.role_id = u.user_role_type_id
        WHERE u.user_id = $1
        FOR UPDATE OF u`,
      [userId],
    );
    const user = rows[0];
    if (user.is_active !== 1 || user.discontinued_at) {
      throw httpError(409, "USER_ALREADY_INACTIVE", `User ${userId} is already deactivated`);
    }
    if (isAdmin && activeAdmins <= 1) {
      throw httpError(409, "LAST_ADMIN", "Cannot deactivate the last active Admin");
    }

    const { rows: updated } = await client.query(
      `UPDATE s_user
          SET is_active = 0, discontinued_at = NOW(), discontinued_by = $1,
              updated_by = $1, updation_timestamp = NOW()
        WHERE user_id = $2
        RETURNING discontinued_at`,
      [actor, userId],
    );

    await writeUserAuditLog(client, {
      performedBy: actor,
      userId,
      actionType: ACTIONS.USER_DEACTIVATED,
      fieldChanged: "is_active",
      oldValue: "1",
      newValue: "0",
      reason,
      ipAddress,
    });

    const { cases, tasks } = await findNeedsReassigning(client, userId);

    return {
      userId,
      email: user.email,
      name: fullName(user),
      role: user.role_name,
      isActive: false,
      deactivatedAt: updated[0].discontinued_at,
      deactivatedBy: actor,
      needsReassigning: {
        counts: { cases: cases.length, tasks: tasks.length },
        cases,
        tasks,
      },
    };
  });
};

module.exports = {
  listNeedsReassigningService,
  resetPasswordService,
  deactivateUserService,
};
