import { describe, it, expect, vi } from 'vitest';
import { cleanAvailability, expandWindows, extractAvailability, DEFAULT_RULES, DEFAULT_ASSUMPTION, UNREADABLE_ASSUMPTION } from '../src/llm/availability.js';
import { availabilityMessages, AVAILABILITY_SYSTEM } from '../src/llm/prompts.js';
import { AVAILABILITY_SCHEMA } from '../src/llm/schemas.js';
import { LLMError } from '../src/llm/adapter.js';

const rule = (days, start, end, date = null) => ({ days, date, start, end });

describe('cleanAvailability', () => {
  it('keeps valid rules and assumptions', () => {
    const raw = { assumptions: ["'after 7' read as 19:00-22:00"], windows: [rule(['Mon', 'Tue'], '19:00', '22:00')] };
    expect(cleanAvailability(raw)).toEqual({ rules: raw.windows, assumptions: raw.assumptions });
  });

  it('drops malformed rules: bad times, end before start, no days or date, unknown days', () => {
    const raw = {
      assumptions: [],
      windows: [
        rule(['Mon'], '7pm', '22:00'),
        rule(['Mon'], '22:00', '19:00'),
        rule(['Mon'], '25:00', '26:00'),
        rule([], '19:00', '22:00'),
        rule(['Funday'], '19:00', '22:00'),
        rule(['Sat', 'Sat', 'Moon'], '09:00', '12:00'),
      ],
    };
    expect(cleanAvailability(raw).rules).toEqual([rule(['Sat'], '09:00', '12:00')]);
  });

  it('treats a dated rule as one-off and ignores its days', () => {
    expect(cleanAvailability({ windows: [rule(['Mon'], '13:00', '17:00', '2026-10-04')] }).rules).toEqual([rule([], '13:00', '17:00', '2026-10-04')]);
  });

  it('falls back to evenings with an assumption when nothing usable is given', () => {
    for (const raw of [{ windows: [], assumptions: [] }, null, { windows: [rule(['Mon'], 'x', 'y')] }]) {
      expect(cleanAvailability(raw)).toEqual({ rules: DEFAULT_RULES, assumptions: [DEFAULT_ASSUMPTION] });
    }
  });
});

describe('expandWindows', () => {
  // 2026-10-02 is a Friday.
  it('expands weekly rules over the horizon, today included', () => {
    const w = expandWindows([rule(['Mon', 'Fri'], '19:00', '22:00')], '2026-10-02', 7);
    expect(w).toEqual([
      { start: '2026-10-02T19:00', end: '2026-10-02T22:00' },
      { start: '2026-10-05T19:00', end: '2026-10-05T22:00' },
      { start: '2026-10-09T19:00', end: '2026-10-09T22:00' },
    ]);
  });

  it('places a one-off rule only on its date, and only inside the horizon', () => {
    expect(expandWindows([rule([], '13:00', '17:00', '2026-10-04')], '2026-10-02', 7)).toEqual([{ start: '2026-10-04T13:00', end: '2026-10-04T17:00' }]);
    expect(expandWindows([rule([], '13:00', '17:00', '2026-11-04')], '2026-10-02', 7)).toEqual([]);
  });

  it('handles an end of 24:00 and sorts across rules', () => {
    const w = expandWindows([rule(['Sat'], '20:00', '24:00'), rule(['Sat'], '09:00', '12:00')], '2026-10-02', 2);
    expect(w).toEqual([
      { start: '2026-10-03T09:00', end: '2026-10-03T12:00' },
      { start: '2026-10-03T20:00', end: '2026-10-04T00:00' },
    ]);
  });

  it('crosses month ends', () => {
    expect(expandWindows([rule(['Sun'], '10:00', '11:00')], '2026-10-30', 3)).toEqual([{ start: '2026-11-01T10:00', end: '2026-11-01T11:00' }]);
  });
});

describe('extractAvailability', () => {
  it('sends the availability prompt and schema and returns cleaned rules', async () => {
    const complete = vi.fn().mockResolvedValue({ assumptions: ['x'], windows: [rule(['Sat'], '09:00', '12:00')] });
    const r = await extractAvailability({ complete }, { brainDump: 'free saturday morning', today: '2026-10-02' });
    expect(r.rules).toEqual([rule(['Sat'], '09:00', '12:00')]);
    const [messages, schema] = complete.mock.calls[0];
    expect(schema).toBe(AVAILABILITY_SCHEMA);
    expect(messages[0].content).toBe(AVAILABILITY_SYSTEM);
    expect(messages[1].content).toMatch(/^Today: Friday 2026-10-02\n\nCALENDAR\nThis week:/);
  });

  it('falls back to evenings when the model output is unreadable', async () => {
    const complete = vi.fn().mockRejectedValue(new LLMError('bad-output', 'cut off'));
    expect(await extractAvailability({ complete }, { brainDump: 'x', today: '2026-10-02' })).toEqual({ rules: DEFAULT_RULES, assumptions: [UNREADABLE_ASSUMPTION] });
  });

  it('lets connection errors through', async () => {
    const complete = vi.fn().mockRejectedValue(new LLMError('unreachable', 'down'));
    await expect(extractAvailability({ complete }, { brainDump: 'x', today: '2026-10-02' })).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('the prompt examples are themselves valid', () => {
    const examples = [...AVAILABILITY_SYSTEM.matchAll(/Reply:\n(\{.*?\})$/gm)].map((m) => JSON.parse(m[1]));
    expect(examples).toHaveLength(2);
    for (const ex of examples) expect(cleanAvailability(ex).rules).toHaveLength(2);
    expect(availabilityMessages({ brainDump: 'x', today: '2026-10-02' })).toHaveLength(2);
  });
});
