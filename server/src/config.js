import 'dotenv/config';
import path from 'node:path';

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

  uploads: {
    // Keep this OUTSIDE the checked-out code so a deploy never wipes attachments.
    dir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'),
    maxSizeMb: int(process.env.UPLOAD_MAX_MB, 10),
  },

  // the address people open TaskFlow at — used for links in Chat messages
  publicUrl: (process.env.APP_PUBLIC_URL || 'https://taskflow.ekosight.com').replace(/\/+$/, ''),

  // Google Chat. The service account comes from three variables taken from the
  // downloaded key; the key file itself is not needed on the server.
  googleChat: {
    clientEmail: process.env.GOOGLE_CHAT_CLIENT_EMAIL || '',
    // read and repaired in lib/googleChat.js; GOOGLE_CHAT_PRIVATE_KEY_BASE64 avoids quoting entirely
    privateKey: process.env.GOOGLE_CHAT_PRIVATE_KEY || process.env.GOOGLE_CHAT_PRIVATE_KEY_BASE64 || '',
    projectId: process.env.GOOGLE_CHAT_PROJECT_ID || '',
    // only for the "project number" authentication audience
    projectNumber: process.env.GOOGLE_CHAT_PROJECT_NUMBER || '',
    // only if the endpoint URL in Google Cloud differs from the default
    audience: process.env.GOOGLE_CHAT_AUDIENCE || '',
    // an administrator the service account reads the user directory as, so
    // admin-installed chats can be matched to people (see docs/GOOGLE_CHAT.md)
    directoryAdmin: process.env.GOOGLE_CHAT_DIRECTORY_ADMIN || '',
  },

  jobs: {
    // background deadline / black-mark scanner
    enabled: bool(process.env.ENABLE_SCANNER, true),
    intervalMinutes: int(process.env.SCANNER_INTERVAL_MINUTES, 15),
  },
};

export const isProd = config.env === 'production';
