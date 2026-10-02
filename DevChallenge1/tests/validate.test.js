import { describe, it, expect, vi } from 'vitest';
import {
  validatePlan,
  parseWithRetry,
  checkShape,
  enforceSizeCap,
  enforceFirstStep,
  cleanDependencies,
  clampMinimum,
  hardSplit,
  PlanError,
  FRIENDLY_ERROR,
} from '../src/validate.js';

const task = (id, minutes, dependsOn = [], extra = {}) => ({
  id,
  goalId: 'g1',
  title: `do ${id}`,
  minutes,
  dependsOn,
  isFirstStep: false,
  ...extra,
});
const plan = (tasks, goals = [{ id: 'g1', title: 'Goal', deadline: '2026-10-09' }]) => ({ goals, tasks });
const deps = (tasks) => Object.fromEntries(tasks.map((t) => [t.id, t.dependsOn]));

describe('checkShape', () => {
  it('accepts a valid plan and normalizes it', () => {
    const r = checkShape(plan([{ id: 't1', goalId: 'g1', title: 'Open the draft', minutes: 4.6 }]));
    expect(r.ok).toBe(true);
    expect(r.plan.tasks[0]).toEqual({ id: 't1', goalId: 'g1', title: 'Open the draft', minutes: 5, dependsOn: [], isFirstStep: false });
  });

  it('accepts a JSON string', () => {
    expect(checkShape(JSON.stringify(plan([]))).ok).toBe(true);
  });

  it('accepts a null deadline', () => {
    expect(checkShape(plan([], [{ id: 'g1', title: 'x', deadline: null }])).ok).toBe(true);
  });

  it.each([
    ['broken JSON', '{"goals": [', /not valid JSON/],
    ['missing arrays', {}, /"goals" must be an array/],
    ['unknown goal', plan([task('t1', 5, [], { goalId: 'nope' })]), /not a known goal/],
    ['duplicate task id', plan([task('t1', 5), task('t1', 5)]), /duplicate task id "t1"/],
    ['non-numeric minutes', plan([task('t1', '25')]), /minutes must be a positive number/],
    ['zero minutes', plan([task('t1', 0)]), /minutes must be a positive number/],
    ['empty title', plan([task('t1', 5, [], { title: ' ' })]), /title must be a non-empty string/],
    ['bad dependsOn', plan([task('t1', 5, 't0')]), /dependsOn must be an array/],
    ['bad deadline', plan([], [{ id: 'g1', title: 'x', deadline: 'Friday' }]), /deadline/],
  ])('rejects %s', (_name, input, message) => {
    const r = checkShape(input);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(message);
  });
});

describe('parseWithRetry', () => {
  const good = plan([task('t1', 5)]);

  it('returns the first valid response without retrying', async () => {
    const request = vi.fn().mockResolvedValue(good);
    await parseWithRetry(request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(null);
  });

  it('retries once with the error message appended', async () => {
    const request = vi.fn().mockResolvedValueOnce({ goals: [] }).mockResolvedValueOnce(good);
    const r = await parseWithRetry(request);
    expect(r.tasks).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toMatch(/"tasks" must be an array/);
  });

  it('throws a friendly error after the second failure', async () => {
    const request = vi.fn().mockResolvedValue('not json');
    const err = await parseWithRetry(request).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.message).toBe(FRIENDLY_ERROR);
    expect(err.details.join()).toMatch(/not valid JSON/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown request as a failed attempt', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(good);
    await expect(parseWithRetry(request)).resolves.toBeTruthy();
  });
});

describe('enforceSizeCap', () => {
  it('leaves tasks within the cap alone and never asks the model', async () => {
    const split = vi.fn();
    const tasks = [task('t1', 25), task('t2', 10)];
    expect(await enforceSizeCap(tasks, 25, split)).toEqual(tasks);
    expect(split).not.toHaveBeenCalled();
  });

  it('replaces an oversized task with the model split, chained, and rewires dependents', async () => {
    const split = vi.fn().mockResolvedValue([
      { title: 'Outline methods', minutes: 20 },
      { title: 'Write methods intro', minutes: 25 },
    ]);
    const tasks = [task('t1', 5), task('t2', 45, ['t1']), task('t3', 10, ['t2'])];
    const r = await enforceSizeCap(tasks, 25, split);

    expect(split).toHaveBeenCalledTimes(1);
    expect(split).toHaveBeenCalledWith(tasks[1], 25);
    expect(r.map((t) => t.id)).toEqual(['t1', 't2.1', 't2.2', 't3']);
    expect(deps(r)).toEqual({ t1: [], 't2.1': ['t1'], 't2.2': ['t2.1'], t3: ['t2.2'] });
    expect(r[1]).toMatchObject({ title: 'Outline methods', minutes: 20, goalId: 'g1' });
  });

  it('only sends the oversized task back', async () => {
    const split = vi.fn().mockResolvedValue([{ title: 'a', minutes: 20 }, { title: 'b', minutes: 20 }]);
    await enforceSizeCap([task('t1', 10), task('t2', 40), task('t3', 25)], 25, split);
    expect(split.mock.calls.map(([t]) => t.id)).toEqual(['t2']);
  });

  it('runs a second round on pieces that are still too big', async () => {
    const split = vi
      .fn()
      .mockResolvedValueOnce([{ title: 'a', minutes: 40 }, { title: 'b', minutes: 20 }])
      .mockResolvedValueOnce([{ title: 'a1', minutes: 20 }, { title: 'a2', minutes: 20 }]);
    const r = await enforceSizeCap([task('t1', 60)], 25, split);
    expect(split).toHaveBeenCalledTimes(2);
    expect(r.map((t) => [t.id, t.minutes])).toEqual([['t1.1.1', 20], ['t1.1.2', 20], ['t1.2', 20]]);
    expect(deps(r)).toEqual({ 't1.1.1': [], 't1.1.2': ['t1.1.1'], 't1.2': ['t1.1.2'] });
  });

  it('hard-splits by code after 2 rounds that still miss the cap', async () => {
    const split = vi.fn().mockResolvedValue([{ title: 'still big', minutes: 60 }]);
    const r = await enforceSizeCap([task('t1', 60)], 25, split);
    expect(split).toHaveBeenCalledTimes(2);
    expect(r.map((t) => t.minutes)).toEqual([20, 20, 20]);
    expect(r.every((t) => t.minutes <= 25)).toBe(true);
  });

  it('hard-splits when the model errors or returns garbage', async () => {
    const throws = vi.fn().mockRejectedValue(new Error('timeout'));
    const garbage = vi.fn().mockResolvedValue([{ nope: true }]);
    for (const split of [throws, garbage, undefined]) {
      const r = await enforceSizeCap([task('t1', 50)], 25, split);
      expect(r.map((t) => t.minutes)).toEqual([25, 25]);
    }
  });

  it('keeps isFirstStep on the first part only', async () => {
    const r = await enforceSizeCap([task('t1', 50, [], { isFirstStep: true })], 25);
    expect(r.map((t) => t.isFirstStep)).toEqual([true, false]);
  });

  it('avoids id collisions with existing tasks', async () => {
    const r = await enforceSizeCap([task('t1', 50), task('t1.1', 5)], 25);
    expect(new Set(r.map((t) => t.id)).size).toBe(r.length);
  });
});

describe('hardSplit', () => {
  it('splits into equal parts that sum to the original and fit the cap', () => {
    expect(hardSplit(task('t', 61), 25).map((p) => p.minutes)).toEqual([21, 20, 20]);
    expect(hardSplit(task('t', 50), 25).map((p) => p.minutes)).toEqual([25, 25]);
    expect(hardSplit(task('t', 50), 25)[1].title).toBe('do t (part 2 of 2)');
  });
});

describe('enforceFirstStep', () => {
  it('uses isFirstStep when present and normalizes to one per goal', async () => {
    const r = await enforceFirstStep([task('t1', 5), task('t2', 5, [], { isFirstStep: true }), task('t3', 5, [], { isFirstStep: true })]);
    expect(r.map((t) => t.isFirstStep)).toEqual([false, true, false]);
  });

  it('falls back to the first task with empty dependsOn', async () => {
    const r = await enforceFirstStep([task('t1', 5, ['t2']), task('t2', 5)]);
    expect(r.map((t) => t.isFirstStep)).toEqual([false, true]);
  });

  it('picks a first step per goal', async () => {
    const r = await enforceFirstStep([task('a', 5), task('b', 5, [], { goalId: 'g2' }), task('c', 5, ['b'], { goalId: 'g2' })]);
    expect(r.filter((t) => t.isFirstStep).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('asks the model for a smaller first step when it is over 10 min', async () => {
    const shrink = vi.fn().mockResolvedValue({ title: 'Open the draft', minutes: 5 });
    const r = await enforceFirstStep([task('t1', 25, [], { isFirstStep: true }), task('t2', 25, ['t1'])], shrink, 25);
    expect(shrink).toHaveBeenCalledTimes(1);
    expect(r[0]).toMatchObject({ id: 't1', title: 'Open the draft', minutes: 5, isFirstStep: true });
    expect(r[1].minutes).toBe(25); // non-first tasks untouched
  });

  it('clamps to 10 min when the model still returns something bigger, errors, or is absent', async () => {
    const tooBig = vi.fn().mockResolvedValue({ title: 'Bigger', minutes: 15 });
    const fails = vi.fn().mockRejectedValue(new Error('x'));
    expect((await enforceFirstStep([task('t1', 25)], tooBig))[0]).toMatchObject({ title: 'Bigger', minutes: 10 });
    expect((await enforceFirstStep([task('t1', 25)], fails))[0]).toMatchObject({ title: 'do t1', minutes: 10 });
    expect((await enforceFirstStep([task('t1', 25)]))[0].minutes).toBe(10);
  });

  it('does not ask when the first step is already small', async () => {
    const shrink = vi.fn();
    await enforceFirstStep([task('t1', 10)], shrink);
    expect(shrink).not.toHaveBeenCalled();
  });
});

describe('cleanDependencies', () => {
  it('drops unknown, self and duplicate references', () => {
    const r = cleanDependencies([task('t1', 5, ['t1', 'ghost']), task('t2', 5, ['t1', 't1', 'nope'])]);
    expect(deps(r)).toEqual({ t1: [], t2: ['t1'] });
  });

  it('breaks a 2-cycle by removing the edge that closes it', () => {
    const r = cleanDependencies([task('a', 5, ['b']), task('b', 5, ['a'])]);
    expect(deps(r)).toEqual({ a: ['b'], b: [] });
  });

  it('breaks a longer cycle and keeps the rest of the chain', () => {
    // a -> b -> c -> a; traversal from a reaches c last, so c -> a goes.
    const r = cleanDependencies([task('a', 5, ['b']), task('b', 5, ['c']), task('c', 5, ['a']), task('d', 5, ['a'])]);
    expect(deps(r)).toEqual({ a: ['b'], b: ['c'], c: [], d: ['a'] });
  });

  it('handles several independent cycles', () => {
    const r = cleanDependencies([task('a', 5, ['b']), task('b', 5, ['a']), task('c', 5, ['d']), task('d', 5, ['c'])]);
    expect(deps(r)).toEqual({ a: ['b'], b: [], c: ['d'], d: [] });
  });

  it('leaves a valid DAG (diamond) untouched', () => {
    const tasks = [task('a', 5), task('b', 5, ['a']), task('c', 5, ['a']), task('d', 5, ['b', 'c'])];
    expect(deps(cleanDependencies(tasks))).toEqual(deps(tasks));
  });
});

describe('clampMinimum', () => {
  it('raises tasks below 5 minutes to 5', () => {
    expect(clampMinimum([task('a', 2), task('b', 5), task('c', 30)]).map((t) => t.minutes)).toEqual([5, 5, 30]);
  });
});

describe('validatePlan (end to end with fake model)', () => {
  it('runs every step and returns a plan the scheduler can use', async () => {
    const raw = plan([
      { id: 't1', goalId: 'g1', title: 'Write the full intro', minutes: 40, dependsOn: [], isFirstStep: true },
      { id: 't2', goalId: 'g1', title: 'Email supervisor', minutes: 2, dependsOn: ['t1', 'ghost', 't3'] },
      { id: 't3', goalId: 'g1', title: 'Fix figures', minutes: 20, dependsOn: ['t2'] }, // cycle with t2
    ]);
    const request = vi.fn().mockResolvedValueOnce('oops').mockResolvedValueOnce(JSON.stringify(raw));
    const splitTask = vi.fn().mockResolvedValue([
      { title: 'Write intro paragraph 1', minutes: 20 },
      { title: 'Write intro paragraph 2', minutes: 20 },
    ]);
    const shrinkFirstStep = vi.fn().mockResolvedValue({ title: 'Open the intro file', minutes: 3 });

    const r = await validatePlan(request, { maxMinutes: 25, splitTask, shrinkFirstStep });

    expect(request).toHaveBeenCalledTimes(2);
    expect(r.tasks.map((t) => [t.id, t.title, t.minutes, t.dependsOn, t.isFirstStep])).toEqual([
      ['t1.1', 'Open the intro file', 5, [], true], // split, shrunk, then raised to the 5 min floor
      ['t1.2', 'Write intro paragraph 2', 20, ['t1.1'], false],
      ['t2', 'Email supervisor', 5, ['t1.2', 't3'], false], // ghost dropped, rewired to last part
      ['t3', 'Fix figures', 20, [], false], // t3 -> t2 closed the cycle, removed
    ]);
    expect(r.goals).toEqual([{ id: 'g1', title: 'Goal', deadline: '2026-10-09' }]);
  });
});
