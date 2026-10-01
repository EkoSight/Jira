/**
 * CSV for spreadsheets, safe to open.
 *
 * A text cell beginning with = + - @ (or a tab / carriage return) is run as a
 * formula by Excel, Sheets and LibreOffice. Such cells are prefixed with an
 * apostrophe so they show as the text they are. Numbers are written as numbers.
 */

const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (DANGEROUS.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const toCsv = (header, rows) =>
  // a byte-order mark so Excel reads ₹ and names correctly
  `﻿${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;

export function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(toCsv(header, rows));
}
