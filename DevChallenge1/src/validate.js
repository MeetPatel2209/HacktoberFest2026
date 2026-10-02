// Validation for the Call 2 (decompose goals) response, run before scheduling.
//
// No model access here: anything that needs to ask the model again is passed in as a function,
// so this stays testable and the adapter stays the only thing that talks to the model.
//
// validatePlan(requestPlan, { maxMinutes, brainDump, splitTask, shrinkFirstStep, toEnglish }) -> Promise<{ goals, tasks }>
//   requestPlan(feedback | null)             -> raw Call 2 response (object or JSON string)
//   splitTask(task, maxMinutes, goal)        -> [{ title, minutes }]  ("split this into steps of at most N minutes")
//   shrinkFirstStep(task, maxMinutes, goal)  -> { title, minutes }    ("give a tiny step to do before this")
//   toEnglish([{ id, title }])               -> [{ id, title }]       ("rewrite these in English")
//
// Order: shape (1), deadline evidence, dependency cleanup (4), size cap (2), first step (3),
// English titles, minimum (5).
// Dependency cleanup runs early because splitting rewires edges and first-step detection
// reads dependsOn; both need clean edges.

export const FIRST_STEP_MAX = 10;
export const MIN_MINUTES = 5;
export const MAX_SPLIT_ROUNDS = 2;

export class PlanError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PlanError';
    this.details = details;
  }
}

export const FRIENDLY_ERROR = "Couldn't turn that into a plan. Try again, or reword it a little.";

export async function validatePlan(requestPlan, { maxMinutes, brainDump, splitTask, shrinkFirstStep, toEnglish } = {}) {
  let plan = await parseWithRetry(requestPlan);
  const goals = checkDeadlineEvidence(plan.goals, brainDump);
  plan = { goals, tasks: cleanDependencies(plan.tasks) };
  plan = { goals, tasks: await enforceSizeCap(plan.tasks, maxMinutes, splitTask, goals) };
  plan = { goals, tasks: await enforceFirstStep(plan.tasks, shrinkFirstStep, maxMinutes, goals) };
  plan = await enforceEnglish(plan, toEnglish);
  return { ...plan, tasks: clampMinimum(plan.tasks) };
}

// 1. Parse against the schema; retry once with the errors appended; then a friendly error.
// A request that throws (model unreachable, timeout) is not retried: the caller needs that error.
export async function parseWithRetry(requestPlan) {
  let feedback = null;
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await requestPlan(feedback);
    const result = checkShape(raw);
    if (result.ok) return result.plan;
    errors = result.errors;
    feedback = `Your previous response was invalid:\n${errors.join('\n')}\nReturn corrected JSON only.`;
  }
  throw new PlanError(FRIENDLY_ERROR, errors);
}

export function checkShape(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { ok: false, errors: [`not valid JSON: ${err.message}`] };
    }
  }
  const errors = [];
  if (!isObject(data)) return { ok: false, errors: ['response must be an object'] };
  if (!Array.isArray(data.goals)) errors.push('"goals" must be an array');
  if (!Array.isArray(data.tasks)) errors.push('"tasks" must be an array');
  if (errors.length) return { ok: false, errors };

  const goalIds = new Set();
  data.goals.forEach((g, i) => {
    if (!isObject(g)) return errors.push(`goals[${i}] must be an object`);
    if (!isNonEmptyString(g.id)) errors.push(`goals[${i}].id must be a non-empty string`);
    else if (goalIds.has(g.id)) errors.push(`duplicate goal id "${g.id}"`);
    else goalIds.add(g.id);
    if (!isNonEmptyString(g.title)) errors.push(`goals[${i}].title must be a non-empty string`);
    if (g.deadline != null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(g.deadline)) {
      errors.push(`goals[${i}].deadline must be YYYY-MM-DD or null`);
    }
    if (g.deadlineText != null && typeof g.deadlineText !== 'string') {
      errors.push(`goals[${i}].deadlineText must be a string or null`);
    }
    if (g.estimatedMinutes != null && !(Number.isFinite(g.estimatedMinutes) && g.estimatedMinutes > 0)) {
      errors.push(`goals[${i}].estimatedMinutes must be a positive number`);
    }
  });

  const taskIds = new Set();
  data.tasks.forEach((t, i) => {
    if (!isObject(t)) return errors.push(`tasks[${i}] must be an object`);
    if (!isNonEmptyString(t.id)) errors.push(`tasks[${i}].id must be a non-empty string`);
    else if (taskIds.has(t.id)) errors.push(`duplicate task id "${t.id}"`);
    else taskIds.add(t.id);
    if (!goalIds.has(t.goalId)) errors.push(`tasks[${i}].goalId "${t.goalId}" is not a known goal`);
    if (!isNonEmptyString(t.title)) errors.push(`tasks[${i}].title must be a non-empty string`);
    if (typeof t.minutes !== 'number' || !Number.isFinite(t.minutes) || t.minutes <= 0) {
      errors.push(`tasks[${i}].minutes must be a positive number`);
    }
    if (t.dependsOn != null && !(Array.isArray(t.dependsOn) && t.dependsOn.every((d) => typeof d === 'string'))) {
      errors.push(`tasks[${i}].dependsOn must be an array of task ids`);
    }
  });
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      goals: data.goals.map((g) => ({
        id: g.id,
        title: g.title,
        deadline: g.deadline ?? null,
        ...('deadlineText' in g && { deadlineText: g.deadlineText ?? null }),
        ...(g.estimatedMinutes != null && { estimatedMinutes: Math.round(g.estimatedMinutes) }),
      })),
      tasks: data.tasks.map((t) => ({
        id: t.id,
        goalId: t.goalId,
        title: t.title,
        minutes: Math.round(t.minutes),
        dependsOn: [...(t.dependsOn ?? [])],
        isFirstStep: t.isFirstStep === true,
      })),
    },
  };
}

// Deadlines need evidence: the model quotes the words that state each deadline (deadlineText).
// If the quote is missing or isn't in the brain-dump, the deadline is dropped rather than guessed.
// Goals from a response without deadlineText are left alone.
export function checkDeadlineEvidence(goals, brainDump) {
  if (brainDump == null) return goals;
  const text = ` ${normalizeText(brainDump)} `;
  return goals.map((g) => {
    if (!('deadlineText' in g) || g.deadline == null) return g;
    const quote = g.deadlineText ? normalizeText(g.deadlineText) : '';
    return quote && text.includes(` ${quote} `) ? g : { ...g, deadline: null };
  });
}

function normalizeText(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// 2. Tasks over maxMinutes go back to the model to split (max 2 rounds), then code splits equally.
export async function enforceSizeCap(tasks, maxMinutes, splitTask, goals = []) {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  let current = tasks;
  for (let round = 0; round < MAX_SPLIT_ROUNDS && splitTask; round++) {
    if (!current.some((t) => t.minutes > maxMinutes)) return current;
    const parts = new Map();
    for (const t of current) {
      if (t.minutes > maxMinutes) {
        const split = await trySplit(splitTask, t, maxMinutes, goalById.get(t.goalId));
        if (split) parts.set(t.id, split);
      }
    }
    current = applySplits(current, parts);
  }
  const parts = new Map();
  for (const t of current) {
    if (t.minutes > maxMinutes) parts.set(t.id, hardSplit(t, maxMinutes));
  }
  return applySplits(current, parts);
}

async function trySplit(splitTask, task, maxMinutes, goal) {
  try {
    const parts = await splitTask(task, maxMinutes, goal);
    const ok =
      Array.isArray(parts) &&
      parts.length > 0 &&
      parts.every((p) => isObject(p) && isNonEmptyString(p.title) && Number.isFinite(p.minutes) && p.minutes > 0);
    return ok ? parts.map((p) => ({ title: p.title, minutes: Math.round(p.minutes) })) : null;
  } catch {
    return null;
  }
}

// Equal parts that sum to the original, each at most maxMinutes.
export function hardSplit(task, maxMinutes) {
  const n = Math.ceil(task.minutes / maxMinutes);
  const base = Math.floor(task.minutes / n);
  const extra = task.minutes % n;
  return Array.from({ length: n }, (_, i) => ({
    title: `${task.title} (part ${i + 1} of ${n})`,
    minutes: base + (i < extra ? 1 : 0),
  }));
}

// Replace each split task with a chain of its parts, in place. The first part inherits
// dependsOn and isFirstStep; anything that depended on the original now depends on the last part.
function applySplits(tasks, partsById) {
  if (partsById.size === 0) return tasks;
  const taken = new Set(tasks.map((t) => t.id));
  const lastPart = new Map();
  const out = [];
  for (const t of tasks) {
    const parts = partsById.get(t.id);
    if (!parts) {
      out.push(t);
      continue;
    }
    let prev = null;
    parts.forEach((p, i) => {
      const id = freshId(`${t.id}.${i + 1}`, taken);
      out.push({
        id,
        goalId: t.goalId,
        title: p.title,
        minutes: p.minutes,
        dependsOn: i === 0 ? [...t.dependsOn] : [prev],
        isFirstStep: i === 0 && t.isFirstStep,
      });
      prev = id;
    });
    lastPart.set(t.id, prev);
  }
  return out.map((t) => ({ ...t, dependsOn: t.dependsOn.map((d) => lastPart.get(d) ?? d) }));
}

// 3. One first step per goal, at most 10 min. If it's bigger, ask the model for a tiny step to do
// before it; the original stays as the next task so no work is lost. If the model can't help,
// split the original into a 10-minute start and the rest.
export async function enforceFirstStep(tasks, shrinkFirstStep, maxMinutes, goals = []) {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const firstIds = new Set();
  for (const g of new Set(tasks.map((t) => t.goalId))) {
    const inGoal = tasks.filter((t) => t.goalId === g);
    const first = inGoal.find((t) => t.isFirstStep) ?? inGoal.find((t) => t.dependsOn.length === 0) ?? inGoal[0];
    firstIds.add(first.id);
  }

  const taken = new Set(tasks.map((t) => t.id));
  const out = [];
  for (const t of tasks) {
    if (!firstIds.has(t.id)) {
      out.push({ ...t, isFirstStep: false });
      continue;
    }
    if (t.minutes <= FIRST_STEP_MAX) {
      out.push({ ...t, isFirstStep: true });
      continue;
    }
    const startId = freshId(`${t.id}.0`, taken);
    const tiny = await tryShrink(shrinkFirstStep, t, maxMinutes, goalById.get(t.goalId));
    const start = tiny
      ? { title: tiny.title, minutes: Math.min(tiny.minutes, FIRST_STEP_MAX) }
      : { title: `${t.title} (first 10 minutes)`, minutes: FIRST_STEP_MAX };
    const rest = tiny ? { title: t.title, minutes: t.minutes } : { title: `${t.title} (finish)`, minutes: t.minutes - FIRST_STEP_MAX };
    out.push({ id: startId, goalId: t.goalId, ...start, dependsOn: [], isFirstStep: true });
    out.push({ ...t, ...rest, dependsOn: [startId, ...t.dependsOn], isFirstStep: false });
  }
  return out;
}

async function tryShrink(shrinkFirstStep, task, maxMinutes, goal) {
  if (!shrinkFirstStep) return null;
  try {
    const s = await shrinkFirstStep(task, maxMinutes, goal);
    const ok =
      isObject(s) && isNonEmptyString(s.title) && !isPlaceholder(s.title) && Number.isFinite(s.minutes) && s.minutes > 0;
    return ok ? { title: s.title, minutes: Math.round(s.minutes) } : null;
  } catch {
    return null;
  }
}

// 4. Drop unknown and self references, then break cycles by removing the edge that closes each one.
export function cleanDependencies(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const deps = new Map(
    tasks.map((t) => [t.id, [...new Set(t.dependsOn ?? [])].filter((d) => ids.has(d) && d !== t.id)]),
  );

  // Iterative DFS in task order. A back edge (to a node on the current path) closes a cycle;
  // it is the last edge of that cycle in traversal order, so drop it.
  const state = new Map(); // undefined = unvisited, 1 = on path, 2 = finished
  for (const root of tasks) {
    if (state.get(root.id)) continue;
    const stack = [{ id: root.id, i: 0 }];
    state.set(root.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = deps.get(frame.id);
      if (frame.i >= list.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const next = list[frame.i];
      const s = state.get(next);
      if (s === 1) {
        list.splice(frame.i, 1);
      } else if (s === 2) {
        frame.i++;
      } else {
        frame.i++;
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  return tasks.map((t) => ({ ...t, dependsOn: deps.get(t.id) }));
}

// English titles only. Anything in Hindi script or with common Hinglish words goes back to the
// model in one batch (up to 2 tries); a rewrite is kept only if it passes the same check.
export async function enforceEnglish(plan, toEnglish) {
  const key = (kind, x) => `${kind}:${x.id}`;
  const fixed = new Map();
  for (let attempt = 0; attempt < 2 && toEnglish; attempt++) {
    const items = [
      ...plan.goals.map((g) => ({ id: key('goal', g), title: g.title })),
      ...plan.tasks.map((t) => ({ id: key('task', t), title: t.title })),
    ].filter((i) => !fixed.has(i.id) && looksNonEnglish(i.title));
    if (items.length === 0) break;
    let rewritten;
    try {
      rewritten = await toEnglish(items);
    } catch {
      break;
    }
    // Models often echo the bare id ("g1") instead of the label we sent ("goal:g1"); accept either
    // when it points at exactly one item we asked about.
    const resolve = (id) => {
      if (items.some((i) => i.id === id)) return id;
      const matches = items.filter((i) => i.id.split(':')[1] === id);
      return matches.length === 1 ? matches[0].id : null;
    };
    for (const r of Array.isArray(rewritten) ? rewritten : []) {
      if (!isObject(r) || !isNonEmptyString(r.title) || looksNonEnglish(r.title)) continue;
      const id = resolve(r.id);
      if (id) fixed.set(id, r.title);
    }
  }
  const apply = (kind) => (x) => (fixed.has(key(kind, x)) ? { ...x, title: fixed.get(key(kind, x)) } : x);
  return { goals: plan.goals.map(apply('goal')), tasks: plan.tasks.map(apply('task')) };
}

// Romanized Hindi words that don't double as common English words ("do", "to", "par", "tab" left out).
const HINGLISH = new Set(
  ('hai hain tha thi karo karna karni karne karke kar ka ke ki ko mein pe aur se wala wale wali kya kaun kaunse ' +
    'kab kal aaj abhi lena dena dekho kholo poocho pucho dhoondo dhundo likho rakho bhejo jaake jao nahi nahin bhi ' +
    'toh yeh woh mera meri mere apna apni apne liye baad pehle saath kuch thoda jaldi ghar').split(' '),
);

export function looksNonEnglish(text) {
  if (/[\u0900-\u097F]/.test(text)) return true; // Devanagari
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((w) => HINGLISH.has(w));
}

// 5. Every task is at least 5 minutes.
export function clampMinimum(tasks) {
  return tasks.map((t) => ({ ...t, minutes: Math.max(MIN_MINUTES, t.minutes) }));
}

// Titles that echo the instructions instead of naming an action ("Tiny Step", "First step 1").
function isPlaceholder(title) {
  return /^(the |a |my )?(tiny |small |first |next |starting )*(step|task|action)s?( \d+)?[.!]?$/i.test(title.trim());
}

function freshId(id, taken) {
  while (taken.has(id)) id += '_';
  taken.add(id);
  return id;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
