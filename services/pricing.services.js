const { getPool } = require("../config/db");

// Fixed config per pack type. Table and column names only ever come from here,
// never from the request, so user input can never reach the SQL text.
const PACK_TYPES = {
  service: {
    packTable: "service_pack",
    packId: "service_pack_id",
    priceTable: "service_pack_pricing",
    priceId: "pricing_id",
    hasServicePack: false,
  },
  addon: {
    packTable: "add_on_pack",
    packId: "add_on_pack_id",
    priceTable: "add_on_pack_pricing",
    priceId: "addon_pricing_id",
    hasServicePack: true,
  },
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const pricingError = (statusCode, error, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.error = error;
  return err;
};

const pool = () => {
  const p = getPool();
  if (!p) {
    throw pricingError(503, "DB_UNAVAILABLE", "Database is not connected");
  }
  return p;
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
    throw err;
  } finally {
    client.release();
  }
};

// ---------- validation ----------

const parsePackType = (packType) => {
  if (packType !== "service" && packType !== "addon") {
    throw pricingError(400, "VALIDATION_ERROR", "packType must be service or addon");
  }
  return packType;
};

const parseId = (value, field) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be a positive integer`);
  }
  return n;
};

const parseOptionalId = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  return parseId(value, field);
};

// Money stays a string so pg can keep its exact numeric value (no float maths).
const parseMoney = (value, field) => {
  if (typeof value !== "number" && typeof value !== "string") {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be a number`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be a number`);
  }
  if (number < 0) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be zero or more`);
  }

  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be a number`);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must have at most 2 decimals`);
  }
  return text;
};

const parseRequiredMoney = (value, field) => {
  if (value === undefined || value === null) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} is required`);
  }
  return parseMoney(value, field);
};

const parseOptionalMoney = (value, field) => {
  if (value === undefined || value === null) return null;
  return parseMoney(value, field);
};

// Kept as a 'YYYY-MM-DD' string. The date is only ever compared in SQL.
const parseDate = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be a real date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw pricingError(400, "VALIDATION_ERROR", `${field} must be a real date in YYYY-MM-DD format`);
  }
  return value;
};

const parseCreatePrice = (cfg, body) => {
  if (body.currencyId === undefined || body.currencyId === null) {
    throw pricingError(400, "VALIDATION_ERROR", "currencyId is required");
  }
  const currencyId = parseId(body.currencyId, "currencyId");

  const price = parseRequiredMoney(body.price, "price");
  let minPrice = parseOptionalMoney(body.minPrice, "minPrice");
  if (minPrice === null) minPrice = price;
  let upfrontPrice = parseOptionalMoney(body.upfrontPrice, "upfrontPrice");
  if (upfrontPrice === null) upfrontPrice = "0";
  let nonNegotiableAmt = parseOptionalMoney(body.nonNegotiableAmt, "nonNegotiableAmt");
  if (nonNegotiableAmt === null) nonNegotiableAmt = "0";

  const validFrom = parseDate(body.validFrom, "validFrom");
  const validTo = parseDate(body.validTo, "validTo");
  if (validFrom !== null && validTo !== null && validFrom > validTo) {
    throw pricingError(400, "VALIDATION_ERROR", "validFrom must be on or before validTo");
  }

  let servicePackId = null;
  if (cfg.hasServicePack) {
    servicePackId = parseOptionalId(body.servicePackId, "servicePackId");
  } else if (body.servicePackId !== undefined && body.servicePackId !== null) {
    throw pricingError(400, "VALIDATION_ERROR", "servicePackId is only allowed for add-on packs");
  }

  return {
    currencyId,
    price,
    minPrice,
    upfrontPrice,
    nonNegotiableAmt,
    validFrom,
    validTo,
    applicationCountryId: parseOptionalId(body.applicationCountryId, "applicationCountryId"),
    destinationCountryId: parseOptionalId(body.destinationCountryId, "destinationCountryId"),
    servicePackId,
  };
};

const CHANGE_FIELDS = ["price", "minPrice", "upfrontPrice", "nonNegotiableAmt", "validFrom"];

const assertOnlyChangeableFields = (body) => {
  for (const field of Object.keys(body)) {
    if (!CHANGE_FIELDS.includes(field)) {
      throw pricingError(
        400,
        "VALIDATION_ERROR",
        "Only price fields and validFrom can be changed; add a new price for a different currency or country",
      );
    }
  }
};

// ---------- row mappers ----------

const priceSelectSql = (cfg) => `
  SELECT p.${cfg.priceId} AS pricing_id,
         p.${cfg.packId} AS pack_id,
         ${cfg.hasServicePack ? "p.service_pack_id" : "NULL::int AS service_pack_id"},
         p.currency_id, c.iso_code AS currency_code,
         p.price, p.min_price, p.upfront_price, p.non_negotiable_amt,
         p.application_country_id, p.destination_country_id,
         p.valid_from_date::text AS valid_from_date,
         p.valid_to_date::text AS valid_to_date,
         p.is_active,
         p.created_by, p.creation_timestamp, p.updated_by, p.updation_timestamp
    FROM ${cfg.priceTable} p
    LEFT JOIN currency c ON c.currency_id = p.currency_id`;

const toPrice = (row, packType) => ({
  id: Number(row.pricing_id),
  packType,
  packId: row.pack_id,
  servicePackId: row.service_pack_id,
  currencyId: row.currency_id,
  currencyCode: row.currency_code,
  price: row.price,
  minPrice: row.min_price,
  upfrontPrice: row.upfront_price,
  nonNegotiableAmt: row.non_negotiable_amt,
  applicationCountryId: row.application_country_id,
  destinationCountryId: row.destination_country_id,
  validFrom: row.valid_from_date,
  validTo: row.valid_to_date,
  isActive: row.is_active === 1,
  createdBy: row.created_by,
  createdAt: row.creation_timestamp,
  updatedBy: row.updated_by,
  updatedAt: row.updation_timestamp,
});

const toPack = (row, packType) => ({
  packType,
  id: row.pack_id,
  name: row.name,
  isActive: row.is_active === 1,
});

// ---------- lookups ----------

const fetchPack = async (db, cfg, packId) => {
  const { rows } = await db.query(
    `SELECT ${cfg.packId} AS pack_id, name, active AS is_active
       FROM ${cfg.packTable}
      WHERE ${cfg.packId} = $1`,
    [packId],
  );
  return rows[0] || null;
};

// Lock the parent pack row so two admins cannot add overlapping prices at once.
const lockPack = async (client, cfg, packId) => {
  const { rows } = await client.query(
    `SELECT ${cfg.packId} AS pack_id
       FROM ${cfg.packTable}
      WHERE ${cfg.packId} = $1
      FOR UPDATE`,
    [packId],
  );
  if (!rows.length) {
    throw pricingError(404, "NOT_FOUND", "Pack not found");
  }
  return rows[0];
};

const fetchPriceById = async (db, cfg, packType, priceId) => {
  const { rows } = await db.query(
    `${priceSelectSql(cfg)} WHERE p.${cfg.priceId} = $1`,
    [priceId],
  );
  return toPrice(rows[0], packType);
};

const fetchPacks = async (db, cfg) => {
  const { rows } = await db.query(
    `SELECT ${cfg.packId} AS pack_id, name, active AS is_active
       FROM ${cfg.packTable}
      ORDER BY name ASC, ${cfg.packId} ASC`,
  );
  return rows;
};

const fetchPricesOnDate = async (db, cfg, packType, date) => {
  const params = [];
  let dateSql = "CURRENT_DATE";
  if (date !== null) {
    params.push(date);
    dateSql = `$${params.length}::date`;
  }

  const { rows } = await db.query(
    `${priceSelectSql(cfg)}
      WHERE p.is_active = 1
        AND COALESCE(p.valid_from_date, '-infinity'::date) <= ${dateSql}
        AND COALESCE(p.valid_to_date, 'infinity'::date) >= ${dateSql}
      ORDER BY c.iso_code ASC NULLS LAST, p.${cfg.priceId} ASC`,
    params,
  );
  return rows.map((row) => toPrice(row, packType));
};

const fetchAllPrices = async (db, cfg, packType, packId) => {
  const orderParts = [
    "c.iso_code ASC NULLS LAST",
    "p.application_country_id ASC NULLS LAST",
    "p.destination_country_id ASC NULLS LAST",
  ];
  if (cfg.hasServicePack) {
    orderParts.push("p.service_pack_id ASC NULLS LAST");
  }
  orderParts.push("p.valid_from_date ASC NULLS FIRST");

  const { rows } = await db.query(
    `${priceSelectSql(cfg)}
      WHERE p.${cfg.packId} = $1
      ORDER BY ${orderParts.join(", ")}`,
    [packId],
  );
  return rows.map((row) => toPrice(row, packType));
};

const listPacksWithPrices = async (db, cfg, packType, date) => {
  const packRows = await fetchPacks(db, cfg);

  const packs = [];
  const packsById = new Map();
  for (const row of packRows) {
    const pack = toPack(row, packType);
    pack.currentPrices = [];
    packs.push(pack);
    packsById.set(pack.id, pack);
  }

  const prices = await fetchPricesOnDate(db, cfg, packType, date);
  for (const price of prices) {
    const pack = packsById.get(price.packId);
    if (pack) pack.currentPrices.push(price);
  }
  return packs;
};

const findOverlappingPrice = async (client, cfg, key, from, to, excludeIds) => {
  const params = [
    key.packId,
    key.currencyId,
    key.applicationCountryId,
    key.destinationCountryId,
  ];
  const conditions = [
    `${cfg.packId} = $1`,
    "currency_id = $2",
    "application_country_id IS NOT DISTINCT FROM $3",
    "destination_country_id IS NOT DISTINCT FROM $4",
  ];

  if (cfg.hasServicePack) {
    params.push(key.servicePackId);
    conditions.push(`service_pack_id IS NOT DISTINCT FROM $${params.length}`);
  }

  // Two ranges overlap when each one starts before the other one ends.
  params.push(to);
  conditions.push(
    `COALESCE(valid_from_date, '-infinity'::date) <= COALESCE($${params.length}::date, 'infinity'::date)`,
  );

  params.push(from);
  conditions.push(
    `COALESCE(valid_to_date, 'infinity'::date) >= COALESCE($${params.length}::date, '-infinity'::date)`,
  );

  conditions.push("is_active = 1");

  if (excludeIds.length) {
    params.push(excludeIds);
    conditions.push(`${cfg.priceId} <> ALL($${params.length}::bigint[])`);
  }

  const { rows } = await client.query(
    `SELECT ${cfg.priceId} FROM ${cfg.priceTable} WHERE ${conditions.join(" AND ")} LIMIT 1`,
    params,
  );
  return rows.length ? rows[0][cfg.priceId] : null;
};

const assertOverlapFree = async (client, cfg, key, from, to, excludeIds) => {
  const found = await findOverlappingPrice(client, cfg, key, from, to, excludeIds);
  if (found !== null) {
    throw pricingError(
      409,
      "OVERLAPPING_PRICE",
      "A price for this pack and currency already covers these dates",
    );
  }
};

// ---------- reference checks ----------

const assertCurrency = async (db, currencyId) => {
  const { rows } = await db.query(
    "SELECT currency_id FROM currency WHERE currency_id = $1 AND discontinued_at IS NULL",
    [currencyId],
  );
  if (!rows.length) {
    throw pricingError(400, "VALIDATION_ERROR", "Currency not found in Manage Currencies");
  }
};

const assertCountry = async (db, countryId) => {
  if (countryId === null) return;
  const { rows } = await db.query("SELECT country_id FROM country WHERE country_id = $1", [
    countryId,
  ]);
  if (!rows.length) {
    throw pricingError(400, "VALIDATION_ERROR", `Country ${countryId} not found`);
  }
};

const assertServicePack = async (db, servicePackId) => {
  if (servicePackId === null) return;
  const { rows } = await db.query(
    "SELECT service_pack_id FROM service_pack WHERE service_pack_id = $1",
    [servicePackId],
  );
  if (!rows.length) {
    throw pricingError(400, "VALIDATION_ERROR", `Service pack ${servicePackId} not found`);
  }
};

// ---------- inserts ----------

const insertPriceRow = async (client, cfg, packType, values) => {
  const columns = [cfg.packId];
  const placeholders = ["$1"];
  const params = [values.packId];

  const add = (column, value, cast) => {
    params.push(value);
    columns.push(column);
    placeholders.push(cast ? `$${params.length}::${cast}` : `$${params.length}`);
  };

  if (cfg.hasServicePack) add("service_pack_id", values.servicePackId);
  add("currency_id", values.currencyId);
  add("price", values.price);
  add("min_price", values.minPrice);
  add("upfront_price", values.upfrontPrice);
  add("non_negotiable_amt", values.nonNegotiableAmt);
  add("application_country_id", values.applicationCountryId);
  add("destination_country_id", values.destinationCountryId);
  add("valid_from_date", values.validFrom, "date");
  add("valid_to_date", values.validTo, "date");
  add("is_active", 1);
  add("created_by", values.createdBy);

  const { rows } = await client.query(
    `INSERT INTO ${cfg.priceTable} (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING ${cfg.priceId}`,
    params,
  );
  return fetchPriceById(client, cfg, packType, rows[0][cfg.priceId]);
};

// ---------- services ----------

const listPricingService = async ({ date } = {}) => {
  const onDate = parseDate(date, "date");
  const db = pool();

  const servicePacks = await listPacksWithPrices(db, PACK_TYPES.service, "service", onDate);
  const addOnPacks = await listPacksWithPrices(db, PACK_TYPES.addon, "addon", onDate);

  return { servicePacks, addOnPacks };
};

const getPricingHistoryService = async (packTypeValue, packIdValue) => {
  const packType = parsePackType(packTypeValue);
  const cfg = PACK_TYPES[packType];
  const packId = parseId(packIdValue, "packId");
  const db = pool();

  const packRow = await fetchPack(db, cfg, packId);
  if (!packRow) {
    throw pricingError(404, "NOT_FOUND", "Pack not found");
  }

  const pack = toPack(packRow, packType);
  pack.prices = await fetchAllPrices(db, cfg, packType, packId);
  return pack;
};

const createPriceService = async (packTypeValue, packIdValue, body, actor) => {
  const packType = parsePackType(packTypeValue);
  const cfg = PACK_TYPES[packType];
  const packId = parseId(packIdValue, "packId");

  return withTransaction(async (client) => {
    await lockPack(client, cfg, packId);

    const input = parseCreatePrice(cfg, body);
    await assertCurrency(client, input.currencyId);
    await assertCountry(client, input.applicationCountryId);
    await assertCountry(client, input.destinationCountryId);
    if (cfg.hasServicePack) await assertServicePack(client, input.servicePackId);

    const key = {
      packId,
      currencyId: input.currencyId,
      applicationCountryId: input.applicationCountryId,
      destinationCountryId: input.destinationCountryId,
      servicePackId: input.servicePackId,
    };
    await assertOverlapFree(client, cfg, key, input.validFrom, input.validTo, []);

    return insertPriceRow(client, cfg, packType, {
      ...key,
      price: input.price,
      minPrice: input.minPrice,
      upfrontPrice: input.upfrontPrice,
      nonNegotiableAmt: input.nonNegotiableAmt,
      validFrom: input.validFrom,
      validTo: input.validTo,
      createdBy: actor,
    });
  });
};

const changePriceService = async (packTypeValue, packIdValue, priceIdValue, body, actor) => {
  const packType = parsePackType(packTypeValue);
  const cfg = PACK_TYPES[packType];
  const packId = parseId(packIdValue, "packId");
  const priceId = parseId(priceIdValue, "priceId");

  return withTransaction(async (client) => {
    await lockPack(client, cfg, packId);

    assertOnlyChangeableFields(body);

    const price = parseRequiredMoney(body.price, "price");
    const validFrom = parseDate(body.validFrom, "validFrom");

    const { rows } = await client.query(
      `SELECT ${cfg.priceId} AS pricing_id,
              ${cfg.packId} AS pack_id,
              ${cfg.hasServicePack ? "service_pack_id" : "NULL::int AS service_pack_id"},
              currency_id, price, min_price, upfront_price, non_negotiable_amt,
              application_country_id, destination_country_id,
              valid_from_date::text AS valid_from_date,
              valid_to_date::text AS valid_to_date,
              is_active,
              COALESCE($3::date, CURRENT_DATE)::text AS new_from,
              ((valid_from_date IS NULL OR COALESCE($3::date, CURRENT_DATE) > valid_from_date)
               AND (valid_to_date IS NULL OR COALESCE($3::date, CURRENT_DATE) <= valid_to_date))
                AS start_ok
         FROM ${cfg.priceTable}
        WHERE ${cfg.priceId} = $1 AND ${cfg.packId} = $2
        FOR UPDATE`,
      [priceId, packId, validFrom],
    );

    const oldRow = rows[0];
    if (!oldRow) {
      throw pricingError(404, "NOT_FOUND", "Price not found");
    }
    if (oldRow.is_active !== 1) {
      throw pricingError(409, "PRICE_INACTIVE", "This price is no longer active");
    }
    if (oldRow.start_ok !== true) {
      throw pricingError(
        409,
        "INVALID_EFFECTIVE_DATE",
        "New price must start after the old price starts and before it ends",
      );
    }

    await client.query(
      `UPDATE ${cfg.priceTable}
          SET valid_to_date = COALESCE($1::date, CURRENT_DATE) - 1,
              updated_by = $2,
              updation_timestamp = NOW()
        WHERE ${cfg.priceId} = $3`,
      [validFrom, actor, priceId],
    );

    let minPrice = parseOptionalMoney(body.minPrice, "minPrice");
    if (minPrice === null) minPrice = price;
    let upfrontPrice = parseOptionalMoney(body.upfrontPrice, "upfrontPrice");
    if (upfrontPrice === null) upfrontPrice = oldRow.upfront_price;
    let nonNegotiableAmt = parseOptionalMoney(body.nonNegotiableAmt, "nonNegotiableAmt");
    if (nonNegotiableAmt === null) nonNegotiableAmt = oldRow.non_negotiable_amt;

    const key = {
      packId,
      currencyId: oldRow.currency_id,
      applicationCountryId: oldRow.application_country_id,
      destinationCountryId: oldRow.destination_country_id,
      servicePackId: oldRow.service_pack_id,
    };

    const created = await insertPriceRow(client, cfg, packType, {
      ...key,
      price,
      minPrice,
      upfrontPrice,
      nonNegotiableAmt,
      validFrom: oldRow.new_from,
      validTo: oldRow.valid_to_date,
      createdBy: actor,
    });

    await assertOverlapFree(client, cfg, key, created.validFrom, created.validTo, [
      priceId,
      created.id,
    ]);

    const closed = await fetchPriceById(client, cfg, packType, priceId);
    return { closed, created };
  });
};

const lookupPriceService = async (query) => {
  const packType = parsePackType(query.packType);
  const cfg = PACK_TYPES[packType];
  const packId = parseId(query.packId, "packId");
  const currencyId = parseId(query.currencyId, "currencyId");
  const date = parseDate(query.date, "date");

  const key = {
    packId,
    currencyId,
    applicationCountryId: parseOptionalId(query.applicationCountryId, "applicationCountryId"),
    destinationCountryId: parseOptionalId(query.destinationCountryId, "destinationCountryId"),
    servicePackId: cfg.hasServicePack
      ? parseOptionalId(query.servicePackId, "servicePackId")
      : null,
  };

  // A blank (NULL) country or service pack on a price row means it applies to
  // all of them. A row that names the exact value is more specific and wins.
  const params = [key.packId, key.currencyId, key.applicationCountryId, key.destinationCountryId];
  const conditions = [
    `p.${cfg.packId} = $1`,
    "p.currency_id = $2",
    "(p.application_country_id IS NULL OR p.application_country_id = $3::int)",
    "(p.destination_country_id IS NULL OR p.destination_country_id = $4::int)",
  ];
  let specificity =
    "(p.application_country_id IS NOT NULL)::int + (p.destination_country_id IS NOT NULL)::int";

  if (cfg.hasServicePack) {
    params.push(key.servicePackId);
    conditions.push(`(p.service_pack_id IS NULL OR p.service_pack_id = $${params.length}::int)`);
    specificity += " + (p.service_pack_id IS NOT NULL)::int";
  }

  params.push(date);
  const dateSql = `COALESCE($${params.length}::date, CURRENT_DATE)`;
  conditions.push(`COALESCE(p.valid_from_date, '-infinity'::date) <= ${dateSql}`);
  conditions.push(`COALESCE(p.valid_to_date, 'infinity'::date) >= ${dateSql}`);
  conditions.push("p.is_active = 1");

  const { rows } = await pool().query(
    `${priceSelectSql(cfg)} WHERE ${conditions.join(" AND ")}
      ORDER BY ${specificity} DESC, p.${cfg.priceId} DESC
      LIMIT 1`,
    params,
  );
  if (!rows.length) {
    throw pricingError(404, "PRICE_NOT_FOUND", "No price found for this pack, currency and date");
  }
  return toPrice(rows[0], packType);
};

module.exports = {
  listPricingService,
  getPricingHistoryService,
  createPriceService,
  changePriceService,
  lookupPriceService,
};
