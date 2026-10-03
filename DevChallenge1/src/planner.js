// App state and the actions the UI calls. Everything here is plain data in, plain data out,
// except createPlan, which talks to the model through the adapter.
//
// State (saved to localStorage as-is):
// {
//   version: 1,
//   input: { text, maxMinutes },
//   goals, tasks,                         validated Call 2 output
//   availability: { rules, assumptions }, Call 1 output; expanded to windows on every re-plan
//   schedule: [{ taskId, start, end }], unscheduled: [taskId],
//   status: { taskId: "done" },
//   notBefore: { taskId: ISO },            skipped tasks wait until their old slot is over
//   createdAt
// }

import { decompose } from './llm/decompose.js';
import { extractAvailability, expandWindows } from './llm/availability.js';
import { schedule } from './scheduler.js';

export const HORIZON_DAYS = 7;
export const DAILY_CAP_MINUTES = 120;

export async function createPlan(llm, { text, maxMinutes }, now = new Date()) {
  const today = localDate(now);
  const [availability, plan] = await Promise.all([
    extractAvailability(llm, { brainDump: text, today }),
    decompose(llm, { brainDump: text, maxMinutes, today }),
  ]);
  const state = {
    version: 1,
    input: { text, maxMinutes },
    goals: plan.goals,
    tasks: plan.tasks,
    availability,
    schedule: [],
    unscheduled: [],
    status: {},
    notBefore: {},
    createdAt: localIso(now),
  };
  return replan(state, now);
}

// Re-run the scheduler for every not-done task from now. Done tasks keep their slot.
export function replan(state, now = new Date()) {
  const windows = expandWindows(state.availability.rules, localDate(now), HORIZON_DAYS);
  const nowIso = localIso(now);
  const notBefore = Object.fromEntries(Object.entries(state.notBefore ?? {}).filter(([, t]) => t > nowIso));
  const { placements, unscheduled } = schedule(state.tasks, windows, now, {
    goals: state.goals,
    status: state.status,
    previous: state.schedule,
    notBefore,
    horizonDays: HORIZON_DAYS,
    dailyCapMinutes: DAILY_CAP_MINUTES,
  });
  return { ...state, schedule: placements, unscheduled, notBefore };
}

// Done is just a tick: nothing moves, so the plan doesn't shuffle under the person's eyes.
export function markDone(state, taskId) {
  return { ...state, status: { ...state.status, [taskId]: 'done' } };
}

export function undoDone(state, taskId) {
  const { [taskId]: _, ...status } = state.status;
  return { ...state, status };
}

// Skip quietly re-plans from now; the skipped task can't land back before its old slot ends.
export function skipTask(state, taskId, now = new Date()) {
  const slot = state.schedule.find((p) => p.taskId === taskId);
  const after = slot && slot.end > localIso(now) ? slot.end : localIso(now);
  return replan({ ...state, notBefore: { ...state.notBefore, [taskId]: after } }, now);
}

// On load: if a not-done task's slot is already over, re-plan from now. No overdue list.
export function refreshOnLoad(state, now = new Date()) {
  const nowIso = localIso(now);
  const missed = state.schedule.some((p) => state.status[p.taskId] !== 'done' && p.end <= nowIso);
  return missed ? replan(state, now) : state;
}

// --- view helpers ---

export function todayItems(state, now = new Date()) {
  const today = localDate(now);
  return state.schedule.filter((p) => p.start.slice(0, 10) === today);
}

// The first not-done task today whose slot hasn't ended; else the next one on a later day.
export function nextItem(state, now = new Date()) {
  const nowIso = localIso(now);
  return state.schedule.find((p) => state.status[p.taskId] !== 'done' && p.end > nowIso) ?? null;
}

export function scheduleByDay(state) {
  const days = new Map();
  for (const p of state.schedule) {
    const day = p.start.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(p);
  }
  return [...days.entries()].map(([date, items]) => ({ date, items }));
}

export function localDate(now) {
  return localIso(now).slice(0, 10);
}

export function localIso(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
