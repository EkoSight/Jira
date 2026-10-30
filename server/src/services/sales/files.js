/**
 * Spreadsheets in and out.
 *
 * Out: Excel (.xlsx) or CSV. A text cell that a spreadsheet would run as a
 * formula (starting = + - @ or a tab) is written as text, never a formula;
 * identifiers (phones, registration numbers) are written as text so their
 * leading zeros survive.
 *
 * In: CSV or Excel. Every cell is read as the text it shows, so a phone typed
 * as text keeps its zeros; a number Excel already stored as a number has lost
 * them, and the importer says so rather than guessing.
 */
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';
import { sendCsv, toCsv } from '../../lib/csv.js';
import { parseCsv } from '../marketing/contacts.js';

const DANGEROUS = /^[=+\-@\t\r]/;
export const safeCellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  const text = String(value);
  return DANGEROUS.test(text) ? `'${text}` : text;
};

/** An .xlsx file as a Buffer. */
export async function xlsxBuffer({ sheet = 'Sheet1', header, rows, textColumns = [] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TaskFlow';
  wb.created = new Date();
  const ws = wb.addWorksheet(String(sheet).slice(0, 31));
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) ws.addRow(row.map(safeCellText));
  // identifier columns are text, so Excel does not turn 09876543210 into 9876543210
  for (const index of textColumns) ws.getColumn(index + 1).numFmt = '@';
  header.forEach((h, i) => {
    const longest = Math.max(String(h).length, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length));
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 2));
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Sends a table as .xlsx or .csv. */
export async function sendTable(res, { filename, format = 'XLSX', sheet, header, rows, textColumns = [] }) {
  const base = String(filename || 'export').replace(/[^A-Za-z0-9._-]/g, '_');
  if (String(format).toUpperCase() === 'CSV') return sendCsv(res, `${base}.csv`, header, rows);
  const buffer = await xlsxBuffer({ sheet, header, rows, textColumns });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(buffer);
}

export { toCsv };

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Reads an uploaded CSV or XLSX into a header row and data rows (all text). */
export async function readTable(buffer, filename = '') {
  if (!buffer?.length) throw badRequest('The file is empty');
  const isXlsx = buffer.subarray(0, 4).equals(XLSX_MAGIC) || /\.xlsx$/i.test(filename);
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer);
    } catch {
      throw badRequest('This is not an Excel (.xlsx) file TaskFlow can read; save it as .xlsx or CSV');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets');
    const rows = [];
    const numericCells = new Set();
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = [];
      for (let c = 1; c <= ws.columnCount; c += 1) {
        const cell = row.getCell(c);
        let text = '';
        if (cell.type === ExcelJS.ValueType.Formula) text = cell.result === undefined || cell.result === null ? '' : String(cell.result);
        else if (cell.type === ExcelJS.ValueType.Date && cell.value instanceof Date) text = cell.value.toISOString().slice(0, 10);
        else if (cell.type === ExcelJS.ValueType.Number) { text = String(cell.value); numericCells.add(`${rowNumber}:${c}`); }
        else if (cell.type === ExcelJS.ValueType.RichText) text = cell.value.richText.map((r) => r.text).join('');
        else if (cell.type === ExcelJS.ValueType.Hyperlink) text = String(cell.value.text ?? cell.value.hyperlink ?? '');
        else text = cell.text ?? (cell.value === null || cell.value === undefined ? '' : String(cell.value));
        values.push(String(text).trim());
      }
      rows.push({ rowNumber, values });
    });
    if (!rows.length) throw badRequest('The sheet is empty');
    const [head, ...data] = rows;
    return {
      kind: 'XLSX',
      header: head.values.map((h) => h.trim()),
      rows: data.map((r) => r.values),
      rowNumbers: data.map((r) => r.rowNumber),
      numericCells,
    };
  }
  const text = buffer.toString('utf8');
  if (/\u0000/.test(text.slice(0, 2000))) throw badRequest('This file is not text; upload a CSV or an .xlsx file');
  const parsed = parseCsv(text);
  if (!parsed.length) throw badRequest('The file is empty');
  const [head, ...data] = parsed;
  return { kind: 'CSV', header: head.map((h) => h.trim()), rows: data, rowNumbers: data.map((_, i) => i + 2), numericCells: new Set() };
}
