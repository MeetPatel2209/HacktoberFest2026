// Runs the manual test cases through the real pipeline (decompose -> Ollama -> validate)
// and reports what the model did on its own versus what code had to fix.
//
//   node prompt-lab/run-cases.mjs <model> [case numbers...]
//   node prompt-lab/run-cases.mjs qwen3:8b
//   node prompt-lab/run-cases.mjs llama3.1:8b 2 5
//
// Results are saved to prompt-lab/results/<model>/case-<n>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOllamaAdapter } from '../src/llm/adapter.js';
import { decompose } from '../src/llm/decompose.js';
import { PLAN_SCHEMA, SPLIT_SCHEMA, FIRST_STEP_SCHEMA, ENGLISH_SCHEMA } from '../src/llm/schemas.js';
import { looksNonEnglish } from '../src/validate.js';
import { CASES, TODAY, MAX_MINUTES } from './cases.js';

const CALL_KIND = new Map([
  [PLAN_SCHEMA, 'plan'],
  [SPLIT_SCHEMA, 'split'],
  [FIRST_STEP_SCHEMA, 'first-step'],
  [ENGLISH_SCHEMA, 'english'],
]);
const VAGUE = /\b(work on|research|think about|prepare|finali[sz]e|plan|review|organi[sz]e)\b/i;

const [model, ...picked] = process.argv.slice(2);
if (!model) {
  console.error('usage: node prompt-lab/run-cases.mjs <model> [case numbers...]');
  process.exit(1);
}
const base = createOllamaAdapter({ model, timeoutMs: 300_000 });
const { think } = base;
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'results', model.replace(/[^a-z0-9.]+/gi, '-'));
mkdirSync(outDir, { recursive: true });

const numbers = picked.length ? picked.map(Number) : CASES.map((_, i) => i + 1);
console.log(`Model ${model}${think === false ? ' (thinking off)' : ''}, today ${TODAY}, max ${MAX_MINUTES} min\n`);

for (const n of numbers) {
  const c = CASES[n - 1];
  const calls = [];
  // Wrap the adapter so every model call is recorded with its kind and time.
  const llm = {
    async complete(messages, schema) {
      const kind = CALL_KIND.get(schema);
      const start = performance.now();
      try {
        const output = await base.complete(messages, schema);
        calls.push({ kind, seconds: secs(start), output });
        return output;
      } catch (err) {
        calls.push({ kind, seconds: secs(start), error: `${err.kind ?? ''} ${err.message}` });
        throw err;
      }
    },
  };

  console.log(`━━ Case ${n}: ${c.name}`);
  console.log(`   "${c.brainDump}"`);
  const start = performance.now();
  let plan;
  let error;
  try {
    plan = await decompose(llm, { brainDump: c.brainDump, maxMinutes: MAX_MINUTES, today: TODAY });
  } catch (err) {
    error = `${err.name}: ${err.message}`;
  }
  const total = secs(start);

  const raw = calls.find((x) => x.kind === 'plan' && x.output)?.output;
  writeFileSync(join(outDir, `case-${n}.json`), JSON.stringify({ model, case: c, today: TODAY, maxMinutes: MAX_MINUTES, totalSeconds: total, calls, plan, error }, null, 2));

  console.log(`   model calls: ${calls.map((x) => `${x.kind} ${x.seconds}s${x.error ? ' FAILED' : ''}`).join(', ')}  (total ${total}s)`);
  if (error) {
    console.log(`   ✗ ${error}\n`);
    continue;
  }

  for (const g of plan.goals) {
    const taskMinutes = plan.tasks.filter((t) => t.goalId === g.id).reduce((sum, t) => sum + t.minutes, 0);
    const quote = g.deadlineText ? ` from "${g.deadlineText}"` : '';
    const size = g.estimatedMinutes ? `  [estimate ${g.estimatedMinutes}m, tasks ${taskMinutes}m${taskMinutes < g.estimatedMinutes / 2 ? ' ⚠ under half' : ''}]` : '';
    console.log(`\n   ${g.id} ${g.title}  [deadline: ${g.deadline ?? 'none'}${quote}]${size}`);
    for (const t of plan.tasks.filter((t) => t.goalId === g.id)) {
      const flags = [VAGUE.test(t.title) && 'vague?', looksNonEnglish(t.title) && 'not English'].filter(Boolean);
      const deps = t.dependsOn.length ? ` ← ${t.dependsOn.join(', ')}` : '';
      console.log(`     ${t.isFirstStep ? '★' : ' '} ${t.id.padEnd(7)} ${String(t.minutes).padStart(2)}m  ${t.title}${deps}${flags.length ? `   ⚠ ${flags.join(', ')}` : ''}`);
    }
  }

  const got = plan.goals.map((g) => g.deadline ?? null).sort();
  const want = [...c.expectDeadlines].sort();
  const deadlinesOk = JSON.stringify(got) === JSON.stringify(want);
  const fixes = [];
  if (raw) {
    const rawOver = raw.tasks.filter((t) => t.minutes > MAX_MINUTES).length;
    const rawFirstBig = raw.tasks.filter((t) => t.isFirstStep && t.minutes > 10).length;
    const rawNonEnglish = [...raw.goals, ...raw.tasks].filter((x) => looksNonEnglish(x.title)).length;
    if (rawOver) fixes.push(`${rawOver} task(s) over ${MAX_MINUTES} min`);
    if (rawFirstBig) fixes.push(`${rawFirstBig} first step(s) over 10 min`);
    if (rawNonEnglish) fixes.push(`${rawNonEnglish} non-English title(s)`);
  }
  console.log(`\n   deadlines: ${deadlinesOk ? '✓' : '✗'} got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  console.log(`   code had to fix: ${fixes.length ? fixes.join('; ') : 'nothing'}\n`);
}

console.log(`Saved to ${outDir}`);

function secs(start) {
  return Math.round((performance.now() - start) / 100) / 10;
}
