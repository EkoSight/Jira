import 'dotenv/config';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  apiPrefix: process.env.API_PREFIX || '/api/taskflow',

  db: {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || 'localhost',
    port: int(process.env.PGPORT, 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'taskflow',
    schema: process.env.DB_SCHEMA || 'taskflow',
    ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: false } : false,
    max: int(process.env.PG_POOL_MAX, 10),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
    tokenTtl: process.env.JWT_TTL || '12h',
    // when TaskFlow is mounted inside the existing app, the host app can supply
    // its own req.user and TaskFlow will trust it instead of issuing tokens
    trustHostAuth: bool(process.env.TRUST_HOST_AUTH, false),
  },

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },

  jobs: {
    // background deadline / black-mark scanner
    enabled: bool(process.env.ENABLE_SCANNER, true),
    intervalMinutes: int(process.env.SCANNER_INTERVAL_MINUTES, 15),
  },
};

export const isProd = config.env === 'production';
