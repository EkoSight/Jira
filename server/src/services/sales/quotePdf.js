/**
 * Quotations and CSR proposals as PDF, in the Soil Doctor brand: Manrope,
 * Deep Green and Paper, the ink lockup. Amounts are printed with their
 * currency code (the brand font has no rupee sign, and a code is never
 * ambiguous) and Indian digit grouping for INR.
 *
 * A quotation that is not approved prints "DRAFT — not approved for sending"
 * across every page, so an unapproved copy cannot pass for the real thing.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { BRAND } from '../../lib/brand.js';

const require = createRequire(import.meta.url);
const fontFile = (weight) => require.resolve(`@fontsource/manrope/files/manrope-latin-${weight}-normal.woff`);
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'brand');

/** "1250000.50", "INR" → "INR 12,50,000.50" */
export function formatAmount(value, currency = 'INR') {
  if (value === null || value === undefined || value === '') return '—';
  const [whole, frac = '00'] = String(value).replace('-', '').split('.');
  const negative = String(value).startsWith('-');
  let grouped;
  if (currency === 'INR' && whole.length > 3) {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  } else {
    grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return `${negative ? '-' : ''}${currency} ${grouped}.${(frac + '00').slice(0, 2)}`;
}

const trimNumber = (v) => {
  const s = String(v ?? '');
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
const dateText = (v) => {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Renders the PDF into a Buffer. `quote` comes from getQuote; `party` is the
 * organization and contact it is addressed to; `letterhead` is the quotes
 * settings.
 */
export function renderQuotePdf({ quote, party = {}, letterhead = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 64, left: 54, right: 54 }, bufferPages: true, info: {
      Title: `${quote.kind === 'CSR_PROPOSAL' ? 'Proposal' : 'Quotation'} ${quote.number} v${quote.version}`,
      Author: letterhead.legalName || letterhead.brand || 'Soil Doctor',
      Creator: 'TaskFlow',
    } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Body', fontFile(400));
    doc.registerFont('Bold', fontFile(700));
    doc.registerFont('Heavy', fontFile(800));

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const isProposal = quote.kind === 'CSR_PROPOSAL';
    const approved = Boolean(quote.approval_current) && ['APPROVED', 'SENT', 'ACCEPTED'].includes(quote.status);

    // ---- header
    try {
      doc.image(path.join(ASSETS, 'lockup-ink.png'), left, 46, { height: 30 });
    } catch {
      doc.font('Heavy').fontSize(18).fillColor(BRAND.deepGreen).text(letterhead.brand || 'Soil Doctor', left, 50);
    }
    doc.font('Heavy').fontSize(20).fillColor(BRAND.deepGreen)
      .text(isProposal ? 'PROPOSAL' : 'QUOTATION', left, 48, { width, align: 'right' });
    doc.font('Body').fontSize(9).fillColor(BRAND.body)
      .text(`${quote.number}  ·  version ${quote.version}`, left, 74, { width, align: 'right' });

    doc.moveTo(left, 96).lineTo(left + width, 96).lineWidth(1).strokeColor(BRAND.lineStrong).stroke();

    // ---- from / to / dates
    const colW = (width - 24) / 3;
    const block = (x, title, lines) => {
      doc.font('Bold').fontSize(8).fillColor(BRAND.muted).text(title.toUpperCase(), x, 110, { width: colW, characterSpacing: 0.6 });
      doc.font('Body').fontSize(9.5).fillColor(BRAND.ink);
      let y = 124;
      for (const [i, line] of lines.filter(Boolean).entries()) {
        doc.font(i === 0 ? 'Bold' : 'Body').text(String(line), x, y, { width: colW });
        y = doc.y + 1;
      }
      return y;
    };
    const fromLines = [letterhead.legalName || letterhead.brand || 'Soil Doctor', letterhead.address, letterhead.email, letterhead.phone, letterhead.website,
      letterhead.taxId ? `${letterhead.taxIdLabel || 'Tax ID'}: ${letterhead.taxId}` : null];
    const toLines = [party.account_name || quote.account_name, party.contact_name ? `Attn: ${party.contact_name}${party.contact_designation ? `, ${party.contact_designation}` : ''}` : null,
      party.address, party.email, party.phone, party.tax_id ? `${letterhead.taxIdLabel || 'Tax ID'}: ${party.tax_id}` : null];
    const dateLines = [`Date: ${dateText(quote.sent_at || quote.updated_at || quote.created_at)}`, `Valid until: ${dateText(quote.valid_until)}`, `Currency: ${quote.currency}`, quote.title ? `Re: ${quote.title}` : null];
    const y1 = block(left, 'From', fromLines);
    const y2 = block(left + colW + 12, isProposal ? 'Prepared for' : 'To', toLines);
    const y3 = block(left + 2 * (colW + 12), 'Details', dateLines);
    doc.y = Math.max(y1, y2, y3) + 16;

    // ---- proposal narrative
    const section = (title, text) => {
      if (!text || !String(text).trim()) return;
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.font('Bold').fontSize(11).fillColor(BRAND.deepGreen).text(title, left, doc.y, { width });
      doc.moveDown(0.25);
      doc.font('Body').fontSize(9.5).fillColor(BRAND.ink).text(String(text), { width, lineGap: 2 });
      doc.moveDown(0.8);
    };
    if (isProposal) {
      section('Project scope', quote.project_scope);
      section('Objectives', quote.objectives);
      section('Intended beneficiaries', quote.beneficiaries);
      section('Geography', quote.geography);
      section('Deliverables', quote.deliverables);
      section('Expected outcomes', quote.outcomes);
      section('Timeline', quote.timeline);
      section('Reporting', quote.reporting_plan);
    }

    // ---- lines
    const lines = quote.lines || [];
    if (lines.length) {
      if (isProposal) {
        if (doc.y > doc.page.height - 160) doc.addPage();
        doc.font('Bold').fontSize(11).fillColor(BRAND.deepGreen).text('Budget', left, doc.y, { width });
        doc.moveDown(0.4);
      }
      const hasTax = lines.some((l) => l.tax_rate !== null && l.tax_rate !== undefined);
      const hasDiscount = lines.some((l) => Number(l.discount_pct) > 0);
      const cols = [
        { key: 'n', label: '#', w: 22, align: 'left' },
        { key: 'description', label: 'Description', w: 0, align: 'left' },
        { key: 'qty', label: 'Qty', w: 46, align: 'right' },
        { key: 'price', label: 'Unit price', w: 88, align: 'right' },
        ...(hasDiscount ? [{ key: 'disc', label: 'Disc.', w: 40, align: 'right' }] : []),
        ...(hasTax ? [{ key: 'tax', label: 'Tax', w: 54, align: 'right' }] : []),
        { key: 'amount', label: 'Amount', w: 92, align: 'right' },
      ];
      const fixed = cols.reduce((s, c) => s + c.w, 0);
      cols.find((c) => c.key === 'description').w = width - fixed;
      const header = () => {
        const y = doc.y;
        doc.rect(left, y, width, 20).fill(BRAND.sand);
        let x = left;
        doc.font('Bold').fontSize(8).fillColor(BRAND.body);
        for (const c of cols) {
          doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: c.w - 8, align: c.align, characterSpacing: 0.4 });
          x += c.w;
        }
        doc.y = y + 24;
      };
      header();
      lines.forEach((l, i) => {
        const cells = {
          n: String(i + 1),
          description: `${l.description}${l.unit ? ` (${l.unit})` : ''}`,
          qty: trimNumber(l.quantity),
          price: formatAmount(l.unit_price, quote.currency).replace(`${quote.currency} `, ''),
          disc: Number(l.discount_pct) > 0 ? `${trimNumber(l.discount_pct)}%` : '',
          tax: l.tax_rate !== null && l.tax_rate !== undefined ? `${l.tax_label || 'Tax'} ${trimNumber(l.tax_rate)}%` : '',
          amount: formatAmount(l.line_total, quote.currency).replace(`${quote.currency} `, ''),
        };
        doc.font('Body').fontSize(9);
        const h = Math.max(...cols.map((c) => doc.heightOfString(cells[c.key], { width: c.w - 8 }))) + 8;
        if (doc.y + h > doc.page.height - doc.page.margins.bottom - 10) {
          doc.addPage();
          header();
        }
        const y = doc.y;
        let x = left;
        doc.fillColor(BRAND.ink);
        for (const c of cols) {
          doc.text(cells[c.key], x + 4, y + 4, { width: c.w - 8, align: c.align });
          x += c.w;
        }
        doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor(BRAND.line).stroke();
        doc.y = y + h + 2;
      });

      // totals
      const totals = [
        ['Subtotal', quote.subtotal],
        ...(Number(quote.discount_total) > 0 ? [['Discount', `-${quote.discount_total}`]] : []),
        ...(Number(quote.tax_total) > 0 ? [['Tax', quote.tax_total]] : []),
      ];
      doc.moveDown(0.4);
      const labelX = left + width - 260;
      for (const [label, value] of totals) {
        const y = doc.y;
        doc.font('Body').fontSize(9.5).fillColor(BRAND.body).text(label, labelX, y, { width: 140, align: 'right' });
        doc.fillColor(BRAND.ink).text(formatAmount(value, quote.currency), labelX + 150, y, { width: 110, align: 'right' });
        doc.y = y + 15;
      }
      const y = doc.y + 2;
      doc.rect(labelX, y, 260, 24).fill(BRAND.deepGreen);
      doc.font('Bold').fontSize(10.5).fillColor(BRAND.paper).text(isProposal ? 'Total budget' : 'Total', labelX + 8, y + 7, { width: 134, align: 'right' });
      doc.text(formatAmount(quote.total, quote.currency), labelX + 150, y + 7, { width: 102, align: 'right' });
      doc.y = y + 36;
    }

    if (isProposal) section('Budget notes', quote.budget_notes);
    section('Terms', quote.terms);
    section('Notes', quote.notes);

    // ---- footer and draft mark on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 40;
      doc.font('Body').fontSize(7.5).fillColor(BRAND.muted)
        .text(`${quote.number} v${quote.version}  ·  ${letterhead.brand || 'Soil Doctor'}  ·  page ${i - range.start + 1} of ${range.count}`,
          left, bottom, { width, align: 'center', lineBreak: false });
      if (!approved) {
        doc.save();
        doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.font('Heavy').fontSize(34).fillColor(BRAND.soil).opacity(0.14)
          .text('DRAFT — not approved for sending', 0, doc.page.height / 2 - 20, { width: doc.page.width, align: 'center', lineBreak: false });
        doc.restore();
        doc.opacity(1);
      }
    }
    doc.end();
  });
}
