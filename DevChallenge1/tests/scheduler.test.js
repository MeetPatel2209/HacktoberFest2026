import { describe, it, expect } from 'vitest';
import { schedule } from '../src/scheduler.js';

// vite.config.js pins TZ=Europe/Berlin (DST ends 2026-10-25 03:00 -> 02:00).
// 2026-10-05 is a Monday.

const task = (id, minutes, goalId = 'g1', dependsOn = []) => ({ id, goalId, title: id, minutes, dependsOn });
const win = (start, end) => ({ start, end });
const ids = (placements) => placements.map((p) => p.taskId);
const byId = (placements) => Object.fromEntries(placements.map((p) => [p.taskId, p]));

const NOW = '2026-10-05T08:00';

describe('schedule', () => {
  it('handles empty input', () => {
    expect(schedule([], [], NOW)).toEqual({ placements: [], unscheduled: [] });
    expect(schedule([], [win('2026-10-05T19:00', '2026-10-05T21:00')], NOW)).toEqual({ placements: [], unscheduled: [] });
  });

  it('unschedules tasks when there are no windows', () => {
    expect(schedule([task('t1', 25)], [], NOW)).toEqual({ placements: [], unscheduled: ['t1'] });
  });

  it('places a single task at the start of the earliest window', () => {
    const r = schedule([task('t1', 25)], [win('2026-10-05T19:00', '2026-10-05T21:00')], NOW);
    expect(r).toEqual({
      placements: [{ taskId: 't1', start: '2026-10-05T19:00', end: '2026-10-05T19:25' }],
      unscheduled: [],
    });
  });

  it('never places before now and rounds now up to the minute', () => {
    const r = schedule([task('t1', 10)], [win('2026-10-05T19:00', '2026-10-05T21:00')], '2026-10-05T19:42:30');
    expect(r.placements[0]).toEqual({ taskId: 't1', start: '2026-10-05T19:43', end: '2026-10-05T19:53' });
  });

  it('orders a dependency chain and keeps the buffer between tasks', () => {
    // Listed in reverse to prove ordering comes from dependsOn, not input order.
    const tasks = [task('t3', 20, 'g1', ['t2']), task('t2', 20, 'g1', ['t1']), task('t1', 10)];
    const r = schedule(tasks, [win('2026-10-05T19:00', '2026-10-05T21:00')], NOW);
    expect(r.placements).toEqual([
      { taskId: 't1', start: '2026-10-05T19:00', end: '2026-10-05T19:10' },
      { taskId: 't2', start: '2026-10-05T19:15', end: '2026-10-05T19:35' },
      { taskId: 't3', start: '2026-10-05T19:40', end: '2026-10-05T20:00' },
    ]);
  });

  it('puts a dependent after its dependency even when an earlier gap would fit it', () => {
    const tasks = [task('big', 50), task('small', 10, 'g1', ['big'])];
    const windows = [win('2026-10-05T18:00', '2026-10-05T18:30'), win('2026-10-05T19:00', '2026-10-05T20:00')];
    const r = schedule(tasks, windows, NOW);
    expect(byId(r.placements).big.start).toBe('2026-10-05T19:00');
    expect(r.unscheduled).toEqual(['small']); // 19:55 + 10 + buffer overflows the window
  });

  it('fills an earlier gap with an independent task', () => {
    const tasks = [task('big', 50, 'g1'), task('small', 10, 'g2')];
    const windows = [win('2026-10-05T18:00', '2026-10-05T18:30'), win('2026-10-05T19:00', '2026-10-05T20:00')];
    const r = schedule(tasks, windows, NOW);
    expect(r.placements).toEqual([
      { taskId: 'small', start: '2026-10-05T18:00', end: '2026-10-05T18:10' },
      { taskId: 'big', start: '2026-10-05T19:00', end: '2026-10-05T19:50' },
    ]);
  });

  it('sends a task larger than any window to unscheduled, and its dependents with it', () => {
    const tasks = [task('t1', 10), task('huge', 90, 'g1', ['t1']), task('after', 10, 'g1', ['huge']), task('other', 10, 'g2')];
    const windows = [win('2026-10-05T19:00', '2026-10-05T20:00'), win('2026-10-06T19:00', '2026-10-06T20:00')];
    const r = schedule(tasks, windows, NOW, { dailyCapMinutes: 600 });
    expect(r.unscheduled).toEqual(['huge', 'after']);
    expect(ids(r.placements)).toEqual(['t1', 'other']);
  });

  it('respects the daily cap and spills to the next day', () => {
    const tasks = [task('a', 50), task('b', 50), task('c', 50)];
    const windows = [win('2026-10-05T09:00', '2026-10-05T17:00'), win('2026-10-06T09:00', '2026-10-06T17:00')];
    const r = schedule(tasks, windows, NOW, { dailyCapMinutes: 120 });
    expect(r.placements).toEqual([
      { taskId: 'a', start: '2026-10-05T09:00', end: '2026-10-05T09:50' },
      { taskId: 'b', start: '2026-10-05T09:55', end: '2026-10-05T10:45' },
      { taskId: 'c', start: '2026-10-06T09:00', end: '2026-10-06T09:50' },
    ]);
  });

  it('lets a smaller task use what is left of the daily cap', () => {
    const tasks = [task('a', 100, 'g1'), task('b', 30, 'g2'), task('c', 20, 'g3')];
    const r = schedule(tasks, [win('2026-10-05T09:00', '2026-10-05T17:00')], NOW, { dailyCapMinutes: 120 });
    expect(ids(r.placements)).toEqual(['a', 'c']);
    expect(r.unscheduled).toEqual(['b']);
  });

  it('unschedules a task bigger than the daily cap rather than squeezing it', () => {
    const r = schedule([task('t1', 130)], [win('2026-10-05T09:00', '2026-10-05T17:00')], NOW, { dailyCapMinutes: 120 });
    expect(r.unscheduled).toEqual(['t1']);
  });

  it('unschedules tasks whose goal deadline has passed', () => {
    const goals = [{ id: 'late', deadline: '2026-10-04' }, { id: 'ok', deadline: '2026-10-09' }];
    const tasks = [task('t1', 10, 'late'), task('t2', 10, 'ok')];
    const r = schedule(tasks, [win('2026-10-05T19:00', '2026-10-05T21:00')], NOW, { goals });
    expect(r.unscheduled).toEqual(['t1']);
    expect(ids(r.placements)).toEqual(['t2']);
  });

  it('does not place a task after its deadline, even when a later window exists', () => {
    const goals = [{ id: 'g1', deadline: '2026-10-05' }];
    const tasks = [task('t1', 50), task('t2', 50, 'g1', ['t1'])];
    const windows = [win('2026-10-05T20:00', '2026-10-05T21:00'), win('2026-10-06T19:00', '2026-10-06T21:00')];
    const r = schedule(tasks, windows, NOW, { goals });
    expect(ids(r.placements)).toEqual(['t1']);
    expect(r.unscheduled).toEqual(['t2']);
  });

  it('treats a date-only deadline as the end of that local day', () => {
    const goals = [{ id: 'g1', deadline: '2026-10-05' }];
    const r = schedule([task('t1', 30)], [win('2026-10-05T23:00', '2026-10-06T01:00')], NOW, { goals });
    expect(r.placements[0]).toEqual({ taskId: 't1', start: '2026-10-05T23:00', end: '2026-10-05T23:30' });

    const tooLate = schedule([task('t1', 30)], [win('2026-10-05T23:45', '2026-10-06T01:00')], NOW, { goals });
    expect(tooLate.unscheduled).toEqual(['t1']);
  });

  it('merges windows that exactly touch into one continuous window', () => {
    const windows = [win('2026-10-05T20:00', '2026-10-05T21:00'), win('2026-10-05T19:00', '2026-10-05T20:00')];
    const r = schedule([task('t1', 90)], windows, NOW);
    expect(r.placements[0]).toEqual({ taskId: 't1', start: '2026-10-05T19:00', end: '2026-10-05T20:30' });
  });

  it('fits a task whose minutes + buffer exactly fill a window, and rejects one minute more', () => {
    const w = [win('2026-10-05T19:00', '2026-10-05T20:00')];
    expect(schedule([task('t1', 55)], w, NOW).placements).toHaveLength(1);
    expect(schedule([task('t1', 56)], w, NOW).unscheduled).toEqual(['t1']);
  });

  it('starts the next task exactly one buffer after the previous ends', () => {
    const r = schedule([task('a', 25, 'g1'), task('b', 25, 'g2')], [win('2026-10-05T19:00', '2026-10-05T20:10')], NOW, {
      bufferMinutes: 10,
    });
    expect(r.placements[1].start).toBe('2026-10-05T19:35');
  });

  it('round-robins across goals, earliest deadline first', () => {
    const goals = [{ id: 'A', deadline: '2026-10-11' }, { id: 'B', deadline: '2026-10-08' }];
    const tasks = [task('a1', 10, 'A'), task('a2', 10, 'A', ['a1']), task('a3', 10, 'A', ['a2']), task('b1', 10, 'B'), task('b2', 10, 'B', ['b1'])];
    const r = schedule(tasks, [win('2026-10-05T09:00', '2026-10-05T17:00')], NOW, { goals });
    expect(ids(r.placements)).toEqual(['b1', 'a1', 'b2', 'a2', 'a3']);
  });

  it('ignores windows outside the horizon', () => {
    const windows = [win('2026-10-12T23:00', '2026-10-12T23:59'), win('2026-10-13T09:00', '2026-10-13T10:00')];
    expect(schedule([task('t1', 10)], windows, NOW, { horizonDays: 7 }).placements).toHaveLength(1);
    expect(schedule([task('t1', 10)], windows.slice(1), NOW, { horizonDays: 7 }).unscheduled).toEqual(['t1']);
  });

  describe('timezone and DST (Europe/Berlin, 2026-10-25)', () => {
    it('runs under the pinned timezone', () => {
      // Guard: without TZ the DST tests below would pass or fail for the wrong reason.
      expect(new Date('2026-10-24T12:00').getTimezoneOffset()).toBe(-120);
      expect(new Date('2026-10-26T12:00').getTimezoneOffset()).toBe(-60);
    });

    it('measures a window across the fall-back change in real minutes', () => {
      // 00:00-04:00 wall clock on the DST day is 5 real hours.
      const r = schedule([task('t1', 290)], [win('2026-10-25T00:00', '2026-10-25T04:00')], '2026-10-24T20:00', {
        dailyCapMinutes: 600,
      });
      expect(r.placements[0]).toEqual({ taskId: 't1', start: '2026-10-25T00:00', end: '2026-10-25T03:50' });
    });

    it('keeps wall-clock times stable for evening windows across the change', () => {
      const tasks = [task('sat', 25, 'g1'), task('sun', 25, 'g1', ['sat']), task('mon', 25, 'g1', ['sun'])];
      const windows = [
        win('2026-10-24T19:00', '2026-10-24T19:30'),
        win('2026-10-25T19:00', '2026-10-25T19:30'),
        win('2026-10-26T19:00', '2026-10-26T19:30'),
      ];
      const r = schedule(tasks, windows, '2026-10-24T08:00');
      expect(r.placements.map((p) => p.start)).toEqual(['2026-10-24T19:00', '2026-10-25T19:00', '2026-10-26T19:00']);
    });

    it('applies the daily cap per local calendar day on the 25-hour day', () => {
      const tasks = [task('a', 60), task('b', 60), task('c', 60)];
      const r = schedule(tasks, [win('2026-10-25T09:00', '2026-10-26T12:00')], '2026-10-25T08:00', {
        dailyCapMinutes: 120,
      });
      expect(r.placements.map((p) => p.start)).toEqual(['2026-10-25T09:00', '2026-10-25T10:05', '2026-10-26T00:00']);
    });

    it('counts the horizon in calendar days across the change', () => {
      // now Oct 20 + 7 days -> plan through the end of Oct 27.
      const inside = schedule([task('t1', 10)], [win('2026-10-27T23:00', '2026-10-27T23:30')], '2026-10-20T08:00');
      const outside = schedule([task('t1', 10)], [win('2026-10-28T00:00', '2026-10-28T01:00')], '2026-10-20T08:00');
      expect(inside.placements).toHaveLength(1);
      expect(outside.unscheduled).toEqual(['t1']);
    });
  });

  describe('re-plan after skip', () => {
    const tasks = [task('t1', 10), task('t2', 25, 'g1', ['t1']), task('t3', 25, 'g1', ['t2'])];
    const windows = [win('2026-10-05T19:00', '2026-10-05T21:00'), win('2026-10-06T19:00', '2026-10-06T21:00')];

    it('keeps done tasks fixed and re-plans skipped and remaining tasks from now', () => {
      const first = schedule(tasks, windows, NOW);
      expect(first.placements.map((p) => p.start)).toEqual(['2026-10-05T19:00', '2026-10-05T19:15', '2026-10-05T19:45']);

      // t1 done, t2 skipped at 19:20.
      const r = schedule(tasks, windows, '2026-10-05T19:20', {
        status: { t1: 'done', t2: 'skipped' },
        previous: first.placements,
      });
      expect(r.placements).toEqual([
        { taskId: 't1', start: '2026-10-05T19:00', end: '2026-10-05T19:10' },
        { taskId: 't2', start: '2026-10-05T19:20', end: '2026-10-05T19:45' },
        { taskId: 't3', start: '2026-10-05T19:50', end: '2026-10-05T20:15' },
      ]);
      expect(r.unscheduled).toEqual([]);
    });

    it('places a skipped task after its notBefore time and lets others use the gap', () => {
      const t = [task('a', 25, 'g1'), task('b', 25, 'g2')];
      const w = [win('2026-10-05T19:00', '2026-10-05T21:00')];
      const r = schedule(t, w, '2026-10-05T19:00', { notBefore: { a: '2026-10-05T19:30' } });
      expect(r.placements).toEqual([
        { taskId: 'b', start: '2026-10-05T19:00', end: '2026-10-05T19:25' },
        { taskId: 'a', start: '2026-10-05T19:30', end: '2026-10-05T19:55' },
      ]);
    });

    it('counts done minutes toward the daily cap', () => {
      const done = [{ taskId: 'd', start: '2026-10-05T19:00', end: '2026-10-05T20:40' }];
      const r = schedule([task('d', 100), task('x', 30, 'g2')], windows, '2026-10-05T20:40', {
        status: { d: 'done' },
        previous: done,
      });
      expect(byId(r.placements).x.start).toBe('2026-10-06T19:00');
    });

    it('treats a done dependency without a slot as satisfied', () => {
      const r = schedule(tasks, windows, NOW, { status: { t1: 'done' } });
      expect(ids(r.placements)).toEqual(['t2', 't3']);
    });
  });
});
