import { describe, it, expect, vi } from 'vitest';
import { buildCalendar, weekdayOf, planMessages, splitMessages, firstStepMessages, englishMessages, PLAN_SYSTEM } from '../src/llm/prompts.js';
import { decompose } from '../src/llm/decompose.js';
import { LLMError } from '../src/llm/adapter.js';
import { PLAN_SCHEMA, SPLIT_SCHEMA, FIRST_STEP_SCHEMA, ENGLISH_SCHEMA } from '../src/llm/schemas.js';
import { checkShape } from '../src/validate.js';

describe('buildCalendar', () => {
  // 2026-10-02 is a Friday.
  const lines = buildCalendar('2026-10-02').split('\n');

  it('starts with today and tomorrow under This week', () => {
    expect(lines.slice(0, 4)).toEqual(['This week:', 'Fri 2026-10-02 (today)', 'Sat 2026-10-03 (tomorrow)', 'Sun 2026-10-04']);
  });

  it('puts Monday to Sunday of the following week under Next week', () => {
    const i = lines.indexOf('Next week:');
    expect(lines.slice(i + 1, i + 8)).toEqual([
      'Mon 2026-10-05',
      'Tue 2026-10-06',
      'Wed 2026-10-07',
      'Thu 2026-10-08',
      'Fri 2026-10-09',
      'Sat 2026-10-10',
      'Sun 2026-10-11',
    ]);
    expect(lines[i + 8]).toBe('Later:');
  });

  it('marks the end of this month and covers 35 days', () => {
    expect(lines).toContain('Sat 2026-10-31 (end of this month)');
    const dates = lines.filter((l) => /\d{4}-/.test(l));
    expect(dates).toHaveLength(35);
    expect(dates.at(-1)).toBe('Thu 2026-11-05');
  });

  it('handles a Sunday (This week is one day) and the last day of a month', () => {
    const sun = buildCalendar('2026-05-31', 9).split('\n');
    expect(sun.slice(0, 4)).toEqual(['This week:', 'Sun 2026-05-31 (today, end of this month)', 'Next week:', 'Mon 2026-06-01 (tomorrow)']);
  });

  it('is unaffected by the DST change (TZ pinned to Europe/Berlin)', () => {
    const l = buildCalendar('2026-10-24', 4).split('\n');
    expect(l.filter((x) => /\d{4}-/.test(x))).toEqual(['Sat 2026-10-24 (today)', 'Sun 2026-10-25 (tomorrow)', 'Mon 2026-10-26', 'Tue 2026-10-27']);
  });

  it('gets weekdays right', () => {
    expect(weekdayOf('2026-10-02')).toBe('Friday');
    expect(weekdayOf('2024-02-29')).toBe('Thursday');
  });
});

describe('message builders', () => {
  it('builds the Call 2 user message with calendar and brain-dump', () => {
    const [sys, user] = planMessages({ brainDump: '  fix resume by monday ', maxMinutes: 25, today: '2026-10-02' });
    expect(sys).toEqual({ role: 'system', content: PLAN_SYSTEM });
    expect(user.role).toBe('user');
    expect(user.content).toMatch(/^Today: Friday 2026-10-02\nMax minutes per task: 25\n\nCALENDAR\nThis week:\n/);
    expect(user.content).toMatch(/\n\nBRAIN-DUMP\nfix resume by monday$/);
  });

  it('appends retry feedback to the user message', () => {
    const [, user] = planMessages({ brainDump: 'x', maxMinutes: 25, today: '2026-10-02' }, 'Your previous response was invalid');
    expect(user.content).toMatch(/BRAIN-DUMP\nx\n\nYour previous response was invalid$/);
  });

  it('the prompt asks for English only', () => {
    expect(PLAN_SYSTEM).toContain('Always write titles in English');
    expect(PLAN_SYSTEM).not.toMatch(/Hinglish stays/);
  });

  it('the few-shot example in the prompt is itself a valid plan', () => {
    const example = JSON.parse(PLAN_SYSTEM.match(/Reply:\n(\{.*\})$/s)[1]);
    expect(checkShape(example).ok).toBe(true);
  });

  it('builds the follow-up messages', () => {
    const task = { title: 'Write the intro', minutes: 40 };
    expect(splitMessages(task, 25, { title: 'Thesis' })[1].content).toBe(
      'Goal: Thesis\nTask: Write the intro (40 min)\nSplit this into steps of at most 25 minutes.',
    );
    expect(firstStepMessages(task, { title: 'Thesis' })[1].content).toMatch(/^Goal: Thesis\nFirst task \(too big to start with\): Write the intro \(40 min\)/);
    expect(englishMessages([{ id: 'task:t1', title: 'Bill pay karo' }])[1].content).toBe('task:t1: Bill pay karo');
  });
});

describe('decompose (fake model)', () => {
  const goodPlan = {
    goals: [{ id: 'g1', title: 'Pay the electricity bill', deadline: '2026-10-03' }],
    tasks: [
      { id: 't1', goalId: 'g1', isFirstStep: true, title: 'Open the electricity bill app', minutes: 5, dependsOn: [] },
      { id: 't2', goalId: 'g1', isFirstStep: false, title: 'Bill pay karo aur receipt lo', minutes: 40, dependsOn: ['t1'] },
    ],
  };

  it('sends each call with its own schema and returns a validated plan', async () => {
    const complete = vi.fn(async (messages, schema) => {
      if (schema === PLAN_SCHEMA) return goodPlan;
      if (schema === SPLIT_SCHEMA) return { steps: [{ title: 'Pay the bill', minutes: 10 }, { title: 'Screenshot the receipt', minutes: 5 }] };
      if (schema === ENGLISH_SCHEMA) return { titles: [] };
      throw new Error('unexpected call');
    });
    const r = await decompose({ complete }, { brainDump: 'kal tak bill pay karna hai', maxMinutes: 25, today: '2026-10-02' });
    expect(r.tasks.map((t) => t.title)).toEqual(['Open the electricity bill app', 'Pay the bill', 'Screenshot the receipt']);
    expect(complete.mock.calls.map(([, s]) => s)).toEqual([PLAN_SCHEMA, SPLIT_SCHEMA]);
  });

  it('asks for English rewrites when the model slips into Hinglish', async () => {
    const complete = vi.fn(async (messages, schema) => {
      if (schema === PLAN_SCHEMA) return { ...goodPlan, tasks: [goodPlan.tasks[0], { ...goodPlan.tasks[1], minutes: 10 }] };
      if (schema === ENGLISH_SCHEMA) return { titles: [{ id: 'task:t2', title: 'Pay the bill and save the receipt' }] };
      if (schema === FIRST_STEP_SCHEMA) throw new Error('unexpected');
    });
    const r = await decompose({ complete }, { brainDump: 'x', maxMinutes: 25, today: '2026-10-02' });
    expect(r.tasks[1].title).toBe('Pay the bill and save the receipt');
  });

  it('retries with feedback when the model output is not JSON', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new LLMError('bad-output', 'Model output was not valid JSON'))
      .mockResolvedValueOnce(goodPlan)
      .mockResolvedValue({ steps: [{ title: 'Pay the bill', minutes: 20 }, { title: 'Save the receipt', minutes: 20 }], titles: [] });
    await decompose({ complete }, { brainDump: 'x', maxMinutes: 25, today: '2026-10-02' });
    expect(complete.mock.calls[1][0][1].content).toMatch(/Your previous response was invalid/);
  });

  it('lets "Ollama unreachable" through so the UI can explain it', async () => {
    const complete = vi.fn().mockRejectedValue(new LLMError('unreachable', "Can't reach Ollama"));
    const err = await decompose({ complete }, { brainDump: 'x', maxMinutes: 25, today: '2026-10-02' }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe('unreachable');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
