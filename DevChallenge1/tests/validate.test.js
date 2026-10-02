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
  enforceEnglish,
  looksNonEnglish,
  checkDeadlineEvidence,
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

describe('checkShape: goal evidence fields', () => {
  it('keeps deadlineText and estimatedMinutes when present', () => {
    const r = checkShape(plan([], [{ id: 'g1', title: 'x', deadlineText: 'by Monday', deadline: '2026-10-05', estimatedMinutes: 59.6 }]));
    expect(r.plan.goals[0]).toEqual({ id: 'g1', title: 'x', deadline: '2026-10-05', deadlineText: 'by Monday', estimatedMinutes: 60 });
  });

  it('rejects a bad deadlineText or estimatedMinutes', () => {
    expect(checkShape(plan([], [{ id: 'g1', title: 'x', deadline: null, deadlineText: 5 }])).ok).toBe(false);
    expect(checkShape(plan([], [{ id: 'g1', title: 'x', deadline: null, estimatedMinutes: -1 }])).ok).toBe(false);
  });
});

describe('checkDeadlineEvidence', () => {
  const dump = 'Thesis due next Friday, resume to Priya by Monday. kal tak bill pay karna hai.';
  const goal = (deadlineText, deadline = '2026-10-09') => ({ id: 'g1', title: 'x', deadlineText, deadline });

  it('keeps a deadline whose quote is in the brain-dump (case and punctuation ignored)', () => {
    expect(checkDeadlineEvidence([goal('due next friday')], dump)[0].deadline).toBe('2026-10-09');
    expect(checkDeadlineEvidence([goal('"by Monday,"')], dump)[0].deadline).toBe('2026-10-09');
    expect(checkDeadlineEvidence([goal('kal tak')], dump)[0].deadline).toBe('2026-10-09');
  });

  it('drops a deadline with no quote or a quote that is not in the text', () => {
    expect(checkDeadlineEvidence([goal(null)], dump)[0].deadline).toBeNull();
    expect(checkDeadlineEvidence([goal('')], dump)[0].deadline).toBeNull();
    expect(checkDeadlineEvidence([goal('by the end of the month')], dump)[0].deadline).toBeNull();
  });

  it('matches whole words only', () => {
    expect(checkDeadlineEvidence([goal('day')], 'by Monday')[0].deadline).toBeNull();
  });

  it('leaves goals alone when there is no deadlineText field or no brain-dump', () => {
    const old = { id: 'g1', title: 'x', deadline: '2026-10-09' };
    expect(checkDeadlineEvidence([old], dump)[0]).toBe(old);
    expect(checkDeadlineEvidence([goal(null)], undefined)[0].deadline).toBe('2026-10-09');
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

  it('does not retry a request that throws, and passes the error through', async () => {
    const request = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(parseWithRetry(request)).rejects.toThrow('ECONNREFUSED');
    expect(request).toHaveBeenCalledTimes(1);
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
    expect(split).toHaveBeenCalledWith(tasks[1], 25, undefined);
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

  it('passes the goal to the model so it has context', async () => {
    const split = vi.fn().mockResolvedValue([{ title: 'a', minutes: 20 }, { title: 'b', minutes: 20 }]);
    const goals = [{ id: 'g1', title: 'Thesis', deadline: null }];
    await enforceSizeCap([task('t1', 40)], 25, split, goals);
    expect(split.mock.calls[0][2]).toBe(goals[0]);
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

  it('puts a tiny model-written step before an oversized first step, keeping the original', async () => {
    const shrink = vi.fn().mockResolvedValue({ title: 'Open the draft', minutes: 5 });
    const goals = [{ id: 'g1', title: 'Thesis', deadline: null }];
    const r = await enforceFirstStep([task('t1', 25, [], { isFirstStep: true }), task('t2', 25, ['t1'])], shrink, 25, goals);
    expect(shrink).toHaveBeenCalledTimes(1);
    expect(shrink.mock.calls[0][2]).toBe(goals[0]);
    expect(r.map((t) => [t.id, t.title, t.minutes, t.dependsOn, t.isFirstStep])).toEqual([
      ['t1.0', 'Open the draft', 5, [], true],
      ['t1', 'do t1', 25, ['t1.0'], false], // original work kept
      ['t2', 'do t2', 25, ['t1'], false],
    ]);
  });

  it('rejects placeholder titles that echo the instructions and falls back to a split', async () => {
    for (const title of ['Tiny Step ', 'First step', 'the next step 1', 'Small task.']) {
      const r = await enforceFirstStep([task('t1', 25)], vi.fn().mockResolvedValue({ title, minutes: 5 }));
      expect(r[0].title).toBe('do t1 (first 10 minutes)');
    }
    const ok = await enforceFirstStep([task('t1', 25)], vi.fn().mockResolvedValue({ title: 'Take the first step file out of the drawer', minutes: 5 }));
    expect(ok[0].title).toBe('Take the first step file out of the drawer');
  });

  it('caps a model-written first step that is still too big at 10 min', async () => {
    const tooBig = vi.fn().mockResolvedValue({ title: 'Bigger', minutes: 15 });
    const r = await enforceFirstStep([task('t1', 25)], tooBig);
    expect(r[0]).toMatchObject({ id: 't1.0', title: 'Bigger', minutes: 10, isFirstStep: true });
    expect(r[1]).toMatchObject({ id: 't1', minutes: 25, dependsOn: ['t1.0'] });
  });

  it('splits off a 10-minute start when the model errors or is absent', async () => {
    const fails = vi.fn().mockRejectedValue(new Error('x'));
    for (const shrink of [fails, undefined]) {
      const r = await enforceFirstStep([task('t1', 25)], shrink);
      expect(r.map((t) => [t.id, t.title, t.minutes, t.dependsOn, t.isFirstStep])).toEqual([
        ['t1.0', 'do t1 (first 10 minutes)', 10, [], true],
        ['t1', 'do t1 (finish)', 15, ['t1.0'], false],
      ]);
    }
  });

  it('keeps the original first step\'s dependencies on the original', async () => {
    const r = await enforceFirstStep([task('t0', 5, [], { goalId: 'g0' }), task('t1', 25, ['t0'], { isFirstStep: true })]);
    expect(r.find((t) => t.id === 't1.0').dependsOn).toEqual([]);
    expect(r.find((t) => t.id === 't1').dependsOn).toEqual(['t1.0', 't0']);
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

describe('looksNonEnglish', () => {
  it.each([
    'Electricity bill ka app kholo',
    'Mummy ke liye doctor appointment',
    'Gym jaake workout karo',
    'बिजली का बिल भरो',
    'Pay the bill aur receipt lo',
  ])('flags %s', (title) => expect(looksNonEnglish(title)).toBe(true));

  it.each([
    'Pay the electricity bill and screenshot the receipt',
    'Do the laundry and put it away',
    'Open a new browser tab to check the bus timetable',
    'Email the resume PDF to Priya',
    "Ask Mom which doctor she wants to see",
  ])('accepts %s', (title) => expect(looksNonEnglish(title)).toBe(false));
});

describe('enforceEnglish', () => {
  const goals = [{ id: 'g1', title: 'Electricity bill pay karna', deadline: null }];
  const tasks = [task('t1', 5, [], { title: 'Bill ka app kholo' }), task('t2', 5, [], { title: 'Check the amount' })];

  it('sends only non-English titles, in one batch, and applies the rewrites', async () => {
    const toEnglish = vi.fn().mockResolvedValue([
      { id: 'goal:g1', title: 'Pay the electricity bill' },
      { id: 'task:t1', title: 'Open the bill app' },
    ]);
    const r = await enforceEnglish({ goals, tasks }, toEnglish);
    expect(toEnglish).toHaveBeenCalledTimes(1);
    expect(toEnglish.mock.calls[0][0]).toEqual([
      { id: 'goal:g1', title: 'Electricity bill pay karna' },
      { id: 'task:t1', title: 'Bill ka app kholo' },
    ]);
    expect(r.goals[0].title).toBe('Pay the electricity bill');
    expect(r.tasks.map((t) => t.title)).toEqual(['Open the bill app', 'Check the amount']);
  });

  it('retries once for rewrites that are still not English, then keeps the original', async () => {
    const toEnglish = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'goal:g1', title: 'Pay the bill' }, { id: 'task:t1', title: 'App kholo' }])
      .mockResolvedValueOnce([{ id: 'task:t1', title: 'Still kholo' }]);
    const r = await enforceEnglish({ goals, tasks }, toEnglish);
    expect(toEnglish).toHaveBeenCalledTimes(2);
    expect(toEnglish.mock.calls[1][0]).toEqual([{ id: 'task:t1', title: 'Bill ka app kholo' }]);
    expect(r.goals[0].title).toBe('Pay the bill');
    expect(r.tasks[0].title).toBe('Bill ka app kholo');
  });

  it('accepts bare ids echoed back by the model, but not ambiguous ones', async () => {
    const plan = { goals: [{ id: 'x1', title: 'Bill pay karna', deadline: null }], tasks: [task('x1', 5, [], { title: 'App kholo', goalId: 'x1' }), task('t2', 5, [], { title: 'Gym jao', goalId: 'x1' })] };
    const toEnglish = vi.fn().mockResolvedValueOnce([
      { id: 'x1', title: 'Ambiguous' }, // matches goal:x1 and task:x1, so ignored
      { id: 't2', title: 'Go to the gym' },
      { id: 'goal:x1', title: 'Pay the bill' },
    ]);
    const r = await enforceEnglish(plan, toEnglish);
    expect(r.goals[0].title).toBe('Pay the bill');
    expect(r.tasks.map((t) => t.title)).toEqual(['App kholo', 'Go to the gym']);
  });

  it('never calls the model when everything is English', async () => {
    const toEnglish = vi.fn();
    const plan = { goals: [{ id: 'g1', title: 'Resume', deadline: null }], tasks: [task('t1', 5)] };
    expect(await enforceEnglish(plan, toEnglish)).toEqual(plan);
    expect(toEnglish).not.toHaveBeenCalled();
  });

  it('keeps the plan when the model errors', async () => {
    const r = await enforceEnglish({ goals, tasks }, vi.fn().mockRejectedValue(new Error('down')));
    expect(r.tasks[0].title).toBe('Bill ka app kholo');
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
      { id: 't2', goalId: 'g1', title: 'Supervisor ko email karo', minutes: 2, dependsOn: ['t1', 'ghost', 't3'] },
      { id: 't3', goalId: 'g1', title: 'Fix figures', minutes: 20, dependsOn: ['t2'] }, // cycle with t2
    ]);
    const request = vi.fn().mockResolvedValueOnce('oops').mockResolvedValueOnce(JSON.stringify(raw));
    const splitTask = vi.fn().mockResolvedValue([
      { title: 'Write intro paragraph 1', minutes: 20 },
      { title: 'Write intro paragraph 2', minutes: 20 },
    ]);
    const shrinkFirstStep = vi.fn().mockResolvedValue({ title: 'Open the intro file', minutes: 3 });
    const toEnglish = vi.fn().mockResolvedValue([{ id: 'task:t2', title: 'Email your supervisor' }]);

    const r = await validatePlan(request, { maxMinutes: 25, splitTask, shrinkFirstStep, toEnglish });

    expect(request).toHaveBeenCalledTimes(2);
    expect(r.tasks.map((t) => [t.id, t.title, t.minutes, t.dependsOn, t.isFirstStep])).toEqual([
      ['t1.1.0', 'Open the intro file', 5, [], true], // tiny start in front, raised to the 5 min floor
      ['t1.1', 'Write intro paragraph 1', 20, ['t1.1.0'], false], // split part kept
      ['t1.2', 'Write intro paragraph 2', 20, ['t1.1'], false],
      ['t2', 'Email your supervisor', 5, ['t1.2', 't3'], false], // ghost dropped, rewired, translated
      ['t3', 'Fix figures', 20, [], false], // t3 -> t2 closed the cycle, removed
    ]);
    expect(r.goals).toEqual([{ id: 'g1', title: 'Goal', deadline: '2026-10-09' }]);
  });
});
