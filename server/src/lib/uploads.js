import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from './errors.js';

export const uploadDir = config.uploads.dir;

/** Created lazily so a fresh checkout does not need the folder committed. */
export function ensureUploadDir() {
  fs.mkdirSync(uploadDir, { recursive: true });
  return uploadDir;
}

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, ensureUploadDir());
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // never trust the client's filename on disk — keep it only as a label
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: config.uploads.maxSizeMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(badRequest(`Files of type ${file.mimetype} are not allowed`));
    }
    cb(null, true);
  },
});

/** Resolves a stored name to a path, refusing anything that escapes the folder. */
export function resolveStoredFile(storedName) {
  const resolved = path.resolve(uploadDir, storedName);
  if (!resolved.startsWith(path.resolve(uploadDir) + path.sep)) {
    throw badRequest('Invalid file reference');
  }
  return resolved;
}

export function deleteStoredFile(storedName) {
  if (!storedName) return;
  try {
    fs.unlinkSync(resolveStoredFile(storedName));
  } catch {
    /* already gone — nothing to do */
  }
}

const PROVIDERS = [
  [/docs\.google\.com\/document/i, 'google-docs'],
  [/docs\.google\.com\/spreadsheets/i, 'google-sheets'],
  [/docs\.google\.com\/presentation/i, 'google-slides'],
  [/docs\.google\.com\/forms/i, 'google-forms'],
  [/drive\.google\.com/i, 'google-drive'],
  [/dropbox\.com/i, 'dropbox'],
  [/sharepoint\.com|onedrive\.live\.com/i, 'onedrive'],
  [/notion\.so/i, 'notion'],
  [/figma\.com/i, 'figma'],
  [/github\.com/i, 'github'],
];

/** Labels a pasted link so the UI can show the right icon. */
export function detectProvider(url) {
  for (const [pattern, name] of PROVIDERS) {
    if (pattern.test(url)) return name;
  }
  return 'link';
}

/** Only http(s) links are accepted — javascript: and data: are rejected. */
export function assertSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('That does not look like a valid link');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw badRequest('Only http and https links can be attached');
  }
  return parsed.toString();
}
