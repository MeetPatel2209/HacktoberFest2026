// Call 1 end to end: brain-dump -> weekly free-time rules -> dated windows for the scheduler.
//
// extractAvailability(llm, { brainDump, today }) -> Promise<{ rules, assumptions }>
// expandWindows(rules, today, horizonDays) -> [{ start, end }] local ISO, for schedule()
//
// Rules are stored, not windows, so a re-plan days later expands them from the new today.

import { LLMError } from './adapter.js';
import { availabilityMessages } from './prompts.js';
import { AVAILABILITY_SCHEMA } from './schemas.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RULES = [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], date: null, start: '18:00', end: '21:00' }];
export const DEFAULT_ASSUMPTION = "You didn't mention free time, so I planned 18:00-21:00 every day.";
export const UNREADABLE_ASSUMPTION = "I couldn't read your free time, so I planned 18:00-21:00 every day.";

export async function extractAvailability(llm, { brainDump, today }) {
  let raw;
  try {
    raw = await llm.complete(availabilityMessages({ brainDump, today }), AVAILABILITY_SCHEMA);
  } catch (err) {
    if (err instanceof LLMError && err.kind === 'bad-output') return { rules: DEFAULT_RULES, assumptions: [UNREADABLE_ASSUMPTION] };
    throw err;
  }
  return cleanAvailability(raw);
}

// Keep well-formed rules; fall back to evenings when nothing usable is left.
export function cleanAvailability(raw) {
  const rules = (Array.isArray(raw?.windows) ? raw.windows : []).map(cleanRule).filter(Boolean);
  const assumptions = (Array.isArray(raw?.assumptions) ? raw.assumptions : []).filter((a) => typeof a === 'string' && a.trim());
  if (rules.length === 0) return { rules: DEFAULT_RULES, assumptions: [DEFAULT_ASSUMPTION] };
  return { rules, assumptions };
}

function cleanRule(w) {
  if (!w || typeof w !== 'object') return null;
  const start = minutesOf(w.start);
  const end = w.end === '24:00' ? 24 * 60 : minutesOf(w.end);
  if (start == null || end == null || end <= start) return null;
  const date = typeof w.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.date) ? w.date : null;
  const days = Array.isArray(w.days) ? [...new Set(w.days.filter((d) => DAY_NAMES.includes(d)))] : [];
  if (!date && days.length === 0) return null;
  return { days: date ? [] : days, date, start: w.start, end: w.end };
}

export function expandWindows(rules, today, horizonDays = 7) {
  const [y, m, d] = today.split('-').map(Number);
  const startUtc = Date.UTC(y, m - 1, d);
  const out = [];
  for (let i = 0; i <= horizonDays; i++) {
    const day = new Date(startUtc + i * DAY_MS);
    const date = day.toISOString().slice(0, 10);
    const name = DAY_NAMES[day.getUTCDay()];
    for (const r of rules) {
      if (r.date ? r.date !== date : !r.days.includes(name)) continue;
      out.push({ start: `${date}T${r.start}`, end: r.end === '24:00' ? `${nextDate(date)}T00:00` : `${date}T${r.end}` });
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function minutesOf(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
