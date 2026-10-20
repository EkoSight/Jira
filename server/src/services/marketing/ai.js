/**
 * The writing assistant: subject lines, rewrites, shorter versions,
 * translation between English and Hindi, preview text and first drafts.
 *
 * Uses Claude through the official Anthropic SDK, only when ANTHROPIC_API_KEY
 * is set on the server. Suggestions are returned for a person to pick from and
 * edit; nothing is put into an email or sent without them.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { badRequest } from '../../lib/errors.js';

export const MODEL = 'claude-opus-5-5';

const TASKS = {
  subjects: 'Write 5 different subject lines for this email. Each under 60 characters, clear and specific, no ALL CAPS, no emoji, no exclamation marks, nothing that reads like spam.',
  preheader: 'Write 3 options for the preview text (preheader) shown after the subject in an inbox. Each 40–100 characters, adding to the subject rather than repeating it.',
  rewrite: 'Rewrite this text to be clearer and more specific, in the brand voice, while keeping every fact, number, date and link exactly as given. Give 2 versions.',
  shorten: 'Make this text about half as long while keeping every fact, number, date and link exactly as given. Give 2 versions.',
  translate_hi: 'Translate this text into natural, simple Hindi (Devanagari script) suitable for farmers and business readers in India. Keep names, product names (Soil Doctor, EkoSight), numbers, dates, links and anything inside {{ }} exactly as written. Give 1 version.',
  translate_en: 'Translate this text into clear, simple Indian English. Keep names, numbers, dates, links and anything inside {{ }} exactly as written. Give 1 version.',
  draft: 'Write a first draft of a short marketing email body (under 180 words) from this brief. Lead with the outcome for the reader, use short paragraphs and plain words, and end with one short call to action (for example "Book a soil test →"). Use **bold** sparingly and [label](https://link) for links only where the brief gives a link. Give 2 versions.',
};

const SYSTEM = `You help the team at EkoSight (maker of Soil Doctor, a soil-testing device and service for Indian agriculture) write marketing emails for customers, leads, farmer producer organizations (FPOs), farmers, students, partners and dealers.
Write in the Soil Doctor brand voice: confident, specific and outcome-led, built on "Data → Intelligence → Decision" — what the soil data shows, what it means, what to do. Prefer concrete outcomes (kg per acre, rupees saved, days) to adjectives. Short, direct calls to action such as "Talk to us" or "Request a demo →". Respectful and warm to farmers, never salesy or hyped.
Never use emoji, ALL CAPS, or more than one exclamation mark. No filler phrases ("revolutionary", "cutting-edge", "game-changer").
Write honestly: never invent facts, prices, offers, dates, statistics or testimonials that the input does not contain. Keep merge tags such as {{first_name}} exactly as written.
Answer only through the JSON format you are given.`;

const SCHEMA = {
  type: 'object',
  properties: { suggestions: { type: 'array', items: { type: 'string' } } },
  required: ['suggestions'],
  additionalProperties: false,
};

let client = null;
// tests swap in a stand-in client
export function setAiClientForTests(fake) { client = fake; }

export const aiAvailable = () => Boolean(config.email.anthropicKey) || Boolean(client);

/** Suggestions for one task. Returns { suggestions: [...], model }. */
export async function assist({ task, text = '', context = '', language = 'en' }) {
  if (!TASKS[task]) throw badRequest('Unknown writing task');
  if (!aiAvailable()) throw badRequest('The writing assistant is not set up: add ANTHROPIC_API_KEY on the server');
  const input = String(text || '').slice(0, 8000);
  if (!input.trim() && task !== 'draft') throw badRequest('Give the text to work on');
  if (!client) client = new Anthropic({ apiKey: config.email.anthropicKey });

  const prompt = [
    TASKS[task],
    context ? `About this email: ${String(context).slice(0, 1000)}` : '',
    task !== 'translate_hi' && task !== 'translate_en' ? `Write in ${language === 'hi' ? 'Hindi (Devanagari script)' : 'English'}.` : '',
    '',
    task === 'draft' ? 'Brief:' : 'Text:',
    input || String(context || '').slice(0, 2000),
  ].filter((line) => line !== null).join('\n');

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      // if a safety check declines, the API retries on its recommended model
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw badRequest('The writing assistant is busy; try again in a minute');
    if (err instanceof Anthropic.AuthenticationError) throw badRequest('The writing assistant key on the server was refused');
    if (err instanceof Anthropic.APIError) throw badRequest(`The writing assistant could not answer (${err.status})`);
    throw badRequest('The writing assistant could not be reached');
  }
  if (response.stop_reason === 'refusal') throw badRequest('The writing assistant declined this request; edit the text and try again');
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || '{}');
  } catch {
    throw badRequest('The writing assistant gave an answer that could not be read; try again');
  }
  const suggestions = (parsed.suggestions || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
  return { suggestions, model: response.model || MODEL };
}
