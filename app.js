require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const winston = require("winston");
const client = require("prom-client");

const { db, getPool } = require("./config/db");

const authRoutes = require("./routes/auth");
const caseStatusRoutes = require("./routes/caseStatus");
const pricingRoutes = require("./routes/pricing");
const userRoutes = require("./routes/users");

const app = express();

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});

if (!client.register.getSingleMetric("process_cpu_user_seconds_total")) {
  client.collectDefaultMetrics();
}

const httpRequestCounter =
  client.register.getSingleMetric("http_requests_total") ||
  new client.Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status"],
  });

const httpRequestDuration =
  client.register.getSingleMetric("http_request_duration_seconds") ||
  new client.Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.1, 0.3, 0.5, 1, 2, 5],
  });

app.set("trust proxy", 1);
app.use(express.json());

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5175",
  "https://theflyingpanda.io",
  "https://theflyingpandatestingtfs.web.app",
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...allowedOrigins],
        styleSrc: ["'self'", "'unsafe-inline'", ...allowedOrigins],
        imgSrc: ["'self'", "data:", ...allowedOrigins],
        fontSrc: ["'self'", ...allowedOrigins],
        connectSrc: ["'self'", ...allowedOrigins],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer-when-downgrade" },
  }),
);

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();

  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : "unmatched",
      status: res.statusCode,
    };

    end(labels);
    httpRequestCounter.inc(labels);

    logger.info({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ip: req.ip,
    });
  });

  next();
});

app.get("/health", async (req, res) => {
  const pool = getPool();

  if (!pool) {
    return res.status(503).json({
      status: "error",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    await pool.query("SELECT 1");
    return res.status(200).json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({
      status: "error",
      database: "disconnected",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/metrics", async (req, res) => {
  if (
    !process.env.METRICS_SECRET ||
    req.headers["x-metrics-key"] !== process.env.METRICS_SECRET
  ) {
    return res.status(403).send("Forbidden");
  }

  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

app.use("/api/auth", authRoutes);
app.use("/api/admin/case-statuses", caseStatusRoutes);
app.use("/api/admin/pricing", pricingRoutes);
app.use("/api/admin/users", userRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  logger.error({
    message: "Unhandled error",
    error: err.message,
  });

  res.status(500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
  });
});

const start = async () => {
  await db();

  if (getPool()) {
    logger.info("Database is working");
  } else {
    logger.warn("Database is not working");
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
};

start().catch((error) => {
  logger.error({
    message: "Failed to start server",
    error: error.message,
  });
  process.exit(1);
});

module.exports = app;
