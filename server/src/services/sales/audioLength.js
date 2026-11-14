/**
 * How long a call recording is, read from the file itself. A length sent by a
 * phone or a browser is never trusted: this is what TaskFlow measures.
 *
 *   m4a / aac / 3gp / 3ga   MPEG-4 audio (Samsung and most current diallers)
 *   mp3, ogg / opus, wav    as music-metadata reads them
 *   amr                     AMR-NB or AMR-WB: counted frame by frame here, each
 *                           frame being 20 ms (older diallers save these)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseBuffer } from 'music-metadata';

export const RECORDING_TYPES = {
  m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', '3gp': 'audio/3gpp', '3ga': 'audio/3gpp',
  mp3: 'audio/mpeg', amr: 'audio/amr', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
};
const PARSE_AS = { '3gp': 'audio/mp4', '3ga': 'audio/mp4', mp4: 'audio/mp4', m4a: 'audio/mp4', opus: 'audio/ogg' };

// bytes per frame, header included, by frame type
const AMR_NB = [13, 14, 16, 18, 20, 21, 27, 32, 6, 1, 1, 1, 1, 1, 1, 1];
const AMR_WB = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 1, 1, 1, 1, 1, 1];

/** The length of an AMR file in seconds, or null when it is not one. */
export function amrSeconds(buffer) {
  const nb = Buffer.from('#!AMR\n');
  const wb = Buffer.from('#!AMR-WB\n');
  let table;
  let pos;
  if (buffer.subarray(0, wb.length).equals(wb)) { table = AMR_WB; pos = wb.length; }
  else if (buffer.subarray(0, nb.length).equals(nb)) { table = AMR_NB; pos = nb.length; }
  else return null;
  let frames = 0;
  while (pos < buffer.length) {
    const type = (buffer[pos] >> 3) & 0x0f;
    pos += table[type];
    frames += 1;
  }
  return Math.round(frames * 0.02 * 1000) / 1000;
}

/** The extension TaskFlow accepts for a file name, or null. */
export function recordingExtension(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return RECORDING_TYPES[ext] ? ext : null;
}

// what the file turned out to be, whatever its name said
const CONTAINER_MIME = [[/^WAVE/i, 'audio/wav'], [/^MPEG$/i, 'audio/mpeg'], [/^(M4A|isom|iso|mp4|3gp)/i, 'audio/mp4'], [/^Ogg/i, 'audio/ogg'], [/^ADTS/i, 'audio/aac']];

/**
 * Reads a recording's length in whole seconds, and the type it really is.
 * Throws when the file cannot be read as audio, so a wrong or damaged file is
 * refused rather than stored with a made-up length.
 */
export async function recordingSeconds(filePath, ext) {
  const buffer = await fs.readFile(filePath);
  return recordingInfo(buffer, ext);
}

export async function recordingInfo(buffer, ext) {
  const amr = amrSeconds(buffer);
  if (amr !== null) return { seconds: Math.round(amr), mime: 'audio/amr' };
  if (ext === 'amr') throw new Error('not an AMR recording');
  const meta = await parseBuffer(buffer, { mimeType: PARSE_AS[ext] || RECORDING_TYPES[ext], size: buffer.length }, { duration: true });
  const seconds = meta?.format?.duration;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('no length found');
  const container = String(meta.format.container || '');
  const mime = CONTAINER_MIME.find(([re]) => re.test(container))?.[1] || RECORDING_TYPES[ext];
  return { seconds: Math.round(seconds), mime };
}
