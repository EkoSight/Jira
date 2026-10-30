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


// Email marketing settings from the environment, read when asked (so a test or
// a restarted worker sees the current values). Credentials live only here,
// never in the database or any API response. See docs/EMAIL_MARKETING.md.
function readEmailEnv() {
  return {
    // log (records, never delivers) | smtp | ses | brevo. Unset in production
    // means sending is not set up.
    provider: (process.env.EMAIL_PROVIDER || '').toLowerCase(),
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: int(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
      secure: bool(process.env.SMTP_SECURE, false),
    },
    ses: {
      region: process.env.AWS_SES_REGION || 'ap-south-1',
      accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY || '',
      configurationSet: process.env.AWS_SES_CONFIGURATION_SET || '',
      // only notifications from this SNS topic are accepted
      snsTopicArn: process.env.AWS_SES_SNS_TOPIC_ARN || '',
    },
    brevo: {
      apiKey: process.env.BREVO_API_KEY || '',
    },
    // part of the webhook address providers without signed webhooks post to
    webhookSecret: process.env.EMAIL_WEBHOOK_SECRET || '',
    // the website calls the conversion endpoint with this key
    conversionKey: process.env.MARKETING_CONVERSION_KEY || '',
    // inbound replies posted by a mail service, with this key
    inboundKey: process.env.MARKETING_INBOUND_KEY || '',
    // the writing assistant
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    // the background sender; on wherever the other jobs run
    workerEnabled: bool(process.env.MARKETING_WORKER, true),
    workerIntervalSeconds: int(process.env.MARKETING_WORKER_INTERVAL_SECONDS, 15),
  };
}

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

  get email() {
    return readEmailEnv();
  },

  // The sales CRM's providers. Secrets live only here, in the server's
  // environment; Settings shows whether each is configured, never the value.
  get sales() {
    return {
      whatsapp: {
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
        appSecret: process.env.WHATSAPP_APP_SECRET || '',
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
        graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
        // a sandbox (test) number is labelled as such everywhere
        sandbox: bool(process.env.WHATSAPP_SANDBOX, false),
      },
      exotel: {
        accountSid: process.env.EXOTEL_ACCOUNT_SID || '',
        apiKey: process.env.EXOTEL_API_KEY || '',
        apiToken: process.env.EXOTEL_API_TOKEN || '',
        subdomain: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
        callerId: process.env.EXOTEL_CALLER_ID || '',
        // Exotel does not sign its callbacks; a secret in the callback URL is checked instead
        callbackSecret: process.env.EXOTEL_CALLBACK_SECRET || '',
      },
      // any other telephony system posting call events, signed with HMAC-SHA256
      callWebhookSecret: process.env.CALL_WEBHOOK_SECRET || '',
      workerEnabled: bool(process.env.SALES_WORKER, true),
      workerIntervalSeconds: int(process.env.SALES_WORKER_INTERVAL_SECONDS, 30),
      // development only: simulated provider events, never on in production
      simulate: bool(process.env.SALES_SIMULATE_PROVIDERS, false),
    };
  },

  jobs: {
    // background deadline / black-mark scanner
    enabled: bool(process.env.ENABLE_SCANNER, true),
    intervalMinutes: int(process.env.SCANNER_INTERVAL_MINUTES, 15),
  },
};

export const isProd = config.env === 'production';
