import { describe, it, expect, vi } from 'vitest';
import { createPlan, replan, markDone, undoDone, skipTask, refreshOnLoad, todayItems, nextItem, scheduleByDay, localIso } from '../src/planner.js';
import { loadState, saveState, clearState, loadDraft, saveDraft, STORAGE_KEY } from '../src/storage.js';
import { PLAN_SCHEMA, AVAILABILITY_SCHEMA } from '../src/llm/schemas.js';

// 2026-10-05 is a Monday. TZ is pinned to Europe/Berlin by vite.config.js.
const at = (iso) => new Date(iso);

const PLAN = {
  goals: [{ id: 'g1', title: 'Thesis', deadlineText: 'by Friday', deadline: '2026-10-09', estimatedMinutes: 60 }],
  tasks: [
    { id: 't1', goalId: 'g1', isFirstStep: true, title: 'Open the thesis file', minutes: 5, dependsOn: [] },
    { id: 't2', goalId: 'g1', isFirstStep: false, title: 'Write the intro', minutes: 25, dependsOn: ['t1'] },
    { id: 't3', goalId: 'g1', isFirstStep: false, title: 'Write section one', minutes: 25, dependsOn: ['t2'] },
  ],
};
const AVAILABILITY = { assumptions: ["'after 7' read as 19:00-22:00"], windows: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], date: null, start: '19:00', end: '22:00' }] };

function fakeLlm() {
  return {
    complete: vi.fn(async (_messages, schema) => {
      if (schema === PLAN_SCHEMA) return structuredClone(PLAN);
      if (schema === AVAILABILITY_SCHEMA) return structuredClone(AVAILABILITY);
      throw new Error('unexpected call');
    }),
  };
}

async function planAt(iso) {
  return createPlan(fakeLlm(), { text: 'thesis by Friday, free after 7 on weekdays', maxMinutes: 25 }, at(iso));
}

describe('createPlan', () => {
  it('runs both model calls and schedules the tasks into the free time', async () => {
    const s = await planAt('2026-10-05T08:00');
    expect(s.version).toBe(1);
    expect(s.input).toEqual({ text: 'thesis by Friday, free after 7 on weekdays', maxMinutes: 25 });
    expect(s.availability.assumptions).toEqual(AVAILABILITY.assumptions);
    expect(s.schedule).toEqual([
      { taskId: 't1', start: '2026-10-05T19:00', end: '2026-10-05T19:05' },
      { taskId: 't2', start: '2026-10-05T19:10', end: '2026-10-05T19:35' },
      { taskId: 't3', start: '2026-10-05T19:40', end: '2026-10-05T20:05' },
    ]);
    expect(s.unscheduled).toEqual([]);
    expect(s.createdAt).toBe('2026-10-05T08:00');
  });
});

describe('done, skip and re-plan', () => {
  it('Done ticks a task without moving anything; undo reverses it', async () => {
    const s = await planAt('2026-10-05T08:00');
    const done = markDone(s, 't1');
    expect(done.status).toEqual({ t1: 'done' });
    expect(done.schedule).toBe(s.schedule);
    expect(undoDone(done, 't1').status).toEqual({});
  });

  it('Skip moves the task after its old slot and keeps done tasks fixed', async () => {
    let s = await planAt('2026-10-05T08:00');
    s = markDone(s, 't1');
    s = skipTask(s, 't2', at('2026-10-05T19:12'));
    expect(s.schedule[0]).toEqual({ taskId: 't1', start: '2026-10-05T19:00', end: '2026-10-05T19:05' });
    // t2 was 19:10-19:35; it now waits until 19:35, and t3 follows it.
    expect(s.schedule.slice(1)).toEqual([
      { taskId: 't2', start: '2026-10-05T19:35', end: '2026-10-05T20:00' },
      { taskId: 't3', start: '2026-10-05T20:05', end: '2026-10-05T20:30' },
    ]);
  });

  it('forgets notBefore entries once they are in the past', async () => {
    let s = await planAt('2026-10-05T08:00');
    s = skipTask(s, 't1', at('2026-10-05T19:01'));
    expect(s.notBefore).toEqual({ t1: '2026-10-05T19:05' });
    expect(replan(s, at('2026-10-05T19:30')).notBefore).toEqual({});
  });

  it('re-plans on load only when a not-done slot was missed', async () => {
    const s = await planAt('2026-10-05T08:00');
    expect(refreshOnLoad(s, at('2026-10-05T18:00'))).toBe(s);
    const later = refreshOnLoad(s, at('2026-10-06T08:00'));
    expect(later.schedule.map((p) => p.start)).toEqual(['2026-10-06T19:00', '2026-10-06T19:10', '2026-10-06T19:40']);
    // A done task in the past is not a missed slot.
    const allDone = ['t1', 't2', 't3'].reduce(markDone, s);
    expect(refreshOnLoad(allDone, at('2026-10-06T08:00'))).toBe(allDone);
  });

  it('expands free time from the current day when re-planning days later', async () => {
    const s = await planAt('2026-10-05T08:00');
    const noDeadline = { ...s, goals: s.goals.map((g) => ({ ...g, deadline: null })) };
    // Oct 12 is past the original 7-day horizon (Oct 5-12); the rules are expanded again from Oct 12.
    const r = replan(noDeadline, at('2026-10-12T08:00'));
    expect(r.schedule[0].start).toBe('2026-10-12T19:00');
    // With the deadline kept, the same tasks honestly don't fit any more.
    expect(replan(s, at('2026-10-12T08:00')).unscheduled).toEqual(['t1', 't2', 't3']);
  });
});

describe('view helpers', () => {
  it('finds today, the next task and groups by day', async () => {
    let s = await planAt('2026-10-05T08:00');
    expect(todayItems(s, at('2026-10-05T08:00')).map((p) => p.taskId)).toEqual(['t1', 't2', 't3']);
    expect(todayItems(s, at('2026-10-06T08:00'))).toEqual([]);
    expect(nextItem(s, at('2026-10-05T08:00')).taskId).toBe('t1');
    s = markDone(s, 't1');
    expect(nextItem(s, at('2026-10-05T08:00')).taskId).toBe('t2');
    expect(scheduleByDay(s)).toEqual([{ date: '2026-10-05', items: s.schedule }]);
  });

  it('formats local time as minute-precision ISO', () => {
    expect(localIso(at('2026-10-25T02:30:59'))).toBe('2026-10-25T02:30');
  });
});

describe('storage', () => {
  const memory = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  };

  it('round-trips state under the versioned key', async () => {
    const store = memory();
    const s = await planAt('2026-10-05T08:00');
    expect(saveState(s, store)).toBe(true);
    expect(store.m.has(STORAGE_KEY)).toBe(true);
    expect(loadState(store)).toEqual(s);
    clearState(store);
    expect(loadState(store)).toBeNull();
  });

  it('ignores missing, corrupt or wrong-version data', () => {
    const store = memory();
    expect(loadState(store)).toBeNull();
    store.setItem(STORAGE_KEY, '{not json');
    expect(loadState(store)).toBeNull();
    store.setItem(STORAGE_KEY, JSON.stringify({ version: 2, tasks: [], schedule: [] }));
    expect(loadState(store)).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadState(broken)).toBeNull();
    expect(saveState({ version: 1 }, broken)).toBe(false);
    expect(() => clearState(broken)).not.toThrow();
    expect(loadState(undefined)).toBeNull();
  });

  it('remembers the draft brain-dump separately', () => {
    const store = memory();
    saveDraft({ text: 'hello', maxMinutes: 15 }, store);
    expect(loadDraft(store)).toEqual({ text: 'hello', maxMinutes: 15 });
  });
});
