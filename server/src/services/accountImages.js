/**
 * Logos and banners for organizations.
 *
 * Kept in the database, not on disk: a deploy that replaces the checkout, a
 * move to another server or a restore from a database backup all keep them.
 * Rows written before this still point at a file; the bytes are copied in the
 * first time the image is served, or at start-up, while that file exists.
 */

import fs from 'node:fs';
import { query } from '../db/pool.js';
import { deleteStoredFile, resolveStoredFile } from '../lib/uploads.js';

// a logo or banner this large is a photograph, not an image for a card
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** The bytes for one image, from the row or — once — from its old file. */
export async function imageBytes(image) {
  if (image.data) return image.data;
  if (!image.stored_name) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(resolveStoredFile(image.stored_name));
  } catch {
    return null;
  }
  await query('UPDATE account_images SET data = $2 WHERE id = $1 AND data IS NULL', [image.id, bytes]);
  return bytes;
}

/**
 * Copies every image still on disk into its row. Runs at start-up; safe to
 * run again. Reports what it found so the log says whether anything is
 * already beyond saving.
 */
export async function backfillAccountImages() {
  const { rows } = await query(
    'SELECT id, account_id, kind, stored_name FROM account_images WHERE data IS NULL ORDER BY id',
  );
  let copied = 0;
  const missing = [];
  for (const image of rows) {
    if (await imageBytes(image)) {
      copied += 1;
      // the row is the record now; the file was only ever a cache of it
      deleteStoredFile(image.stored_name);
    } else {
      missing.push(image);
    }
  }
  return { copied, missing };
}

/** Removes a file left behind by an upload that did not end in a row. */
export const discardUpload = (file) => file && deleteStoredFile(file.filename);
