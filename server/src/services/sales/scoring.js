/**
 * Lead scoring: transparent and configurable, never an opaque model.
 *
 * Each criterion has a weight; each is read from something a person answered
 * or something that happened. A criterion with no answer contributes nothing
 * and is listed as missing, so a low score can be told apart from an unknown
 * one. A score is not a probability and is never used as one: forecasts use
 * the deal's stage probability.
 */
import { query } from '../../db/pool.js';
import { isEligible } from './core.js';

const DAY = 24 * 3600 * 1000;

/** How each criterion reads a lead: a value from 0 to 1, or null when not known. */
export const CRITERIA = {
  fit: { label: 'Fit', read: (l) => ({ STRONG: 1, PARTIAL: 0.5, WEAK: 0 }[l.fit] ?? null), explain: (l) => (l.fit ? `Fit: ${l.fit.toLowerCase()}` : 'Fit not assessed') },
  need_clarity: { label: 'Requirement clarity', read: (l) => ({ CLEAR: 1, PARTIAL: 0.5, VAGUE: 0.1 }[l.need_clarity] ?? null), explain: (l) => (l.need_clarity ? `Requirement ${l.need_clarity.toLowerCase()}` : 'Requirement clarity not assessed') },
  budget: {
    label: 'Budget',
    read: (l) => (l.budget_confirmed === true ? 1 : l.budget_amount !== null && l.budget_amount !== undefined ? 0.7 : l.budget_confirmed === false ? 0 : null),
    explain: (l) => (l.budget_confirmed === true ? 'Budget confirmed' : l.budget_amount ? 'Budget indicated, not confirmed' : l.budget_confirmed === false ? 'No budget yet' : 'Budget not known'),
  },
  decision_maker: {
    label: 'Decision maker engaged',
    read: (l) => (l.decision_maker_engaged === true ? 1 : l.decision_maker_engaged === false ? 0 : null),
    explain: (l) => (l.decision_maker_engaged === true ? 'Decision maker engaged' : l.decision_maker_engaged === false ? 'Decision maker not yet engaged' : 'Not known whether the decision maker is engaged'),
  },
  timeline: {
    label: 'Timeline',
    read: (l) => ({ IMMEDIATE: 1, QUARTER: 0.75, HALF_YEAR: 0.5, YEAR: 0.25, UNKNOWN: 0 }[l.timeline] ?? null),
    explain: (l) => (l.timeline ? `Timeline: ${{ IMMEDIATE: 'now', QUARTER: 'this quarter', HALF_YEAR: 'within six months', YEAR: 'within a year', UNKNOWN: 'they do not know' }[l.timeline]}` : 'Timeline not asked'),
  },
  recency: {
    label: 'Recent two-way contact',
    // this is recorded, not asked, so it is never "missing"
    read: (l, now) => {
      if (!l.last_contacted_at) return 0;
      const age = (now - new Date(l.last_contacted_at).getTime()) / DAY;
      return age <= 7 ? 1 : age <= 30 ? 0.5 : 0.2;
    },
    explain: (l, now) => (l.last_contacted_at ? `Last spoke ${Math.max(0, Math.round((now - new Date(l.last_contacted_at).getTime()) / DAY))} day(s) ago` : 'Never spoken to'),
  },
  proposal_ready: {
    label: 'Ready for a proposal',
    read: (l) => (l.status === 'QUALIFIED' ? 1 : l.status === 'QUALIFYING' ? 0.5 : 0),
    explain: (l) => (l.status === 'QUALIFIED' ? 'Qualified' : l.status === 'QUALIFYING' ? 'Being qualified' : 'Not yet qualified'),
  },
};

let cache = { at: 0, models: null };
export async function scoringModels({ fresh = false } = {}) {
  if (!fresh && cache.models && Date.now() - cache.at < 30_000) return cache.models;
  const { rows } = await query('SELECT * FROM crm_scoring_models');
  cache = { at: Date.now(), models: Object.fromEntries(rows.map((r) => [r.category, r])) };
  return cache.models;
}
export const forgetScoringModels = () => { cache = { at: 0, models: null }; };

/** The score and what made it, for a lead under its category's model. */
export function scoreLead(lead, model, now = Date.now()) {
  if (!model || !model.is_enabled || !isEligible(lead.category)) return { score: null, breakdown: [], missing: [] };
  const breakdown = [];
  let total = 0;
  let weights = 0;
  const missing = [];
  for (const c of model.criteria || []) {
    const def = CRITERIA[c.key];
    const weight = Number(c.weight) || 0;
    if (!def || weight <= 0) continue;
    weights += weight;
    const value = def.read(lead, now);
    const points = value === null ? 0 : Math.round(weight * value * 10) / 10;
    if (value === null) missing.push(c.label || def.label);
    total += points;
    breakdown.push({ key: c.key, label: c.label || def.label, weight, value, points, missing: value === null, note: def.explain(lead, now) });
  }
  const score = weights ? Math.round((total / weights) * 100) : null;
  return { score, breakdown, missing };
}

/** Recomputes and stores a lead's score. */
export async function refreshScore(client, leadId) {
  const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1', [leadId]);
  const lead = rows[0];
  if (!lead) return null;
  const models = await scoringModels();
  const { score, breakdown } = scoreLead(lead, models[lead.category]);
  await client.query(
    'UPDATE crm_leads SET score = $2, score_breakdown = $3, score_computed_at = now() WHERE id = $1',
    [leadId, score, JSON.stringify(breakdown)],
  );
  return score;
}

export const effectiveScore = (lead) => (lead.score_override ?? lead.score ?? null);
