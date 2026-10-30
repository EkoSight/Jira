/**
 * Words and small helpers for the sales CRM screens. Labels are the ones the
 * guides use, so what a person reads on screen and in Help is the same.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export const CATEGORY = {
  B2B_CORPORATE: { label: 'B2B corporate', short: 'B2B', tone: 'brand', where: 'Taskflow' },
  CSR_NGO: { label: 'CSR / NGO', short: 'CSR/NGO', tone: 'good', where: 'Taskflow' },
  RETAILER: { label: 'Retailer', short: 'Retailer', tone: 'warning', where: 'TeleCRM' },
  FPO: { label: 'FPO (farmer producer organization)', short: 'FPO', tone: 'warning', where: 'TeleCRM' },
  INDIVIDUAL: { label: 'Individual / farmer', short: 'Individual', tone: 'warning', where: 'TeleCRM' },
  UNCLASSIFIED: { label: 'Not classified yet', short: 'Unclassified', tone: 'neutral', where: 'Classification queue' },
};
export const ELIGIBLE = ['B2B_CORPORATE', 'CSR_NGO'];
export const EXCLUDED = ['RETAILER', 'FPO', 'INDIVIDUAL'];

export const LEAD_STATUS = {
  NEW: { label: 'New', tone: 'brand' },
  CONTACTED: { label: 'Contacted', tone: 'neutral' },
  QUALIFYING: { label: 'Qualifying', tone: 'neutral' },
  QUALIFIED: { label: 'Qualified', tone: 'good' },
  NURTURE: { label: 'Nurture', tone: 'neutral' },
  CONVERTED: { label: 'Converted', tone: 'good' },
  DISQUALIFIED: { label: 'Disqualified', tone: 'critical' },
};

export const DESTINATION = {
  TASKFLOW: { label: 'In Taskflow', tone: 'good' },
  TELECRM: { label: 'For TeleCRM', tone: 'warning' },
  TRIAGE: { label: 'Needs classification', tone: 'critical' },
};

export const ROUTING_STATUS = {
  ACTIVE: 'Active in Taskflow',
  HANDOFF_PENDING: 'Waiting to be exported to TeleCRM',
  HANDOFF_EXPORTED: 'Exported; waiting for confirmation',
  HANDED_OFF: 'Confirmed in TeleCRM',
  HANDOFF_FAILED: 'Hand-off failed',
  NEEDS_CLASSIFICATION: 'Needs classification',
  LEGACY_UNCONFIRMED: 'Existing record: category to confirm',
  EXCLUDED: 'Excluded (TeleCRM category)',
};

export const PRIORITY = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' };
export const FOLLOWUP_KIND = {
  CALL: 'Call', CALLBACK: 'Call back', MEETING: 'Meeting', EMAIL: 'Email', WHATSAPP: 'WhatsApp', DEMO: 'Demo',
  DOCUMENT: 'Document request', VISIT: 'Visit', OTHER: 'Other',
};
export const CALL_OUTCOME = {
  CONNECTED: 'Connected — spoke to them', INTERESTED: 'Interested', NOT_INTERESTED: 'Not interested', CALLBACK_REQUESTED: 'Asked for a call back',
  NO_ANSWER: 'No answer', BUSY: 'Busy', WRONG_NUMBER: 'Wrong number', LEFT_MESSAGE: 'Left a message',
};
export const COMPLETE_OUTCOME = {
  CONNECTED: 'Done — spoke to them', DONE: 'Done', LEFT_MESSAGE: 'Left a message', NO_ANSWER: 'No answer', BUSY: 'Busy',
  WRONG_NUMBER: 'Wrong number', NOT_DONE: 'Not done',
};
export const QUOTE_STATUS = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  IN_REVIEW: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved — ready to send', tone: 'brand' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'critical' },
  SENT: { label: 'Sent', tone: 'brand' },
  ACCEPTED: { label: 'Accepted', tone: 'good' },
  DECLINED: { label: 'Declined', tone: 'critical' },
  SUPERSEDED: { label: 'Replaced by a newer version', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};
export const ACCEPTANCE = {
  EMAIL_REPLY: 'Email reply', PURCHASE_ORDER: 'Purchase order', SIGNED_COPY: 'Signed copy', VERBAL: 'Verbally (note who and when)',
  MEETING: 'In a meeting', WHATSAPP: 'On WhatsApp', OTHER: 'Other',
};
export const PARTY_ROLE = {
  FUNDER: 'Funder', CONTRACTING: 'Signs the contract', PAYING: 'Pays', IMPLEMENTING_PARTNER: 'Implementing partner',
  BUYER: 'Buyer', REFERRAL: 'Referred us', PARTNER: 'Partner', OTHER: 'Other',
};
export const PAYMENT_MODE = {
  BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CHEQUE: 'Cheque', CASH: 'Cash', CARD: 'Card', ONLINE: 'Online', GRANT_DISBURSEMENT: 'Grant disbursement', OTHER: 'Other',
};
export const WA_STATUS = {
  QUEUED: { label: 'Accepted, waiting for status', tone: 'neutral' },
  SENT: { label: 'Sent', tone: 'neutral' },
  DELIVERED: { label: 'Delivered', tone: 'brand' },
  READ: { label: 'Read', tone: 'good' },
  FAILED: { label: 'Failed', tone: 'critical' },
  RECEIVED: { label: 'Received', tone: 'good' },
  BLOCKED: { label: 'Not sent: opted out', tone: 'critical' },
};

/** "1250000.50" + "INR" → "₹12,50,000.50"; other currencies keep their code. */
export function money(value, currency = 'INR') {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const text = n.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return currency === 'INR' ? `₹${text}` : `${currency} ${text}`;
}

export const when = (value) => (value ? new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
export const dayOf = (value) => (value ? new Date(String(value).length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const localDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + offsetDays * 86400000));
/** A datetime-local value N hours from now, in the browser's time. */
export function inHours(hours) {
  const d = new Date(Date.now() + hours * 3600_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const toIso = (local) => (local ? new Date(local).toISOString() : null);

let cached = null;
let pending = null;
/** The sales CRM's reference data (categories, stages, users, settings, permissions), loaded once. */
export function useSalesMeta(version = 0) {
  const [meta, setMeta] = useState(cached);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (cached && !version) { setMeta(cached); return; }
    pending = pending || api.sales.get('/meta').then((m) => { cached = m; return m; }).finally(() => { pending = null; });
    pending.then(setMeta).catch(setError);
  }, [version]);
  return { meta, error };
}
export const forgetSalesMeta = () => { cached = null; };

export const userName = (meta, id) => meta?.users?.find((u) => u.id === id)?.full_name || (id ? `User ${id}` : 'Nobody');
