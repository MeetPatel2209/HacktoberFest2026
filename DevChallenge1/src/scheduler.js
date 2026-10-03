// Deterministic scheduler. Pure function: no DOM, no model, no Date.now().
//
// schedule(tasks, freeWindows, now, options) -> { placements, unscheduled }
//
// tasks:        [{ id, goalId, minutes, dependsOn: [ids] }]
// freeWindows:  [{ start, end }] local ISO strings ("2026-10-05T19:00")
// now:          Date | ISO string | epoch ms
// options:
//   goals:            [{ id, deadline }]   deadline "YYYY-MM-DD" (end of that local day) or full ISO
//   bufferMinutes:    gap kept after every task (default 5)
//   dailyCapMinutes:  max scheduled task minutes per local day (default 120)
//   horizonDays:      plan through the end of today + N days (default 7)
//   status:           { taskId: "done" | "skipped" } — anything but "done" is re-planned
//   previous:         [{ taskId, start, end }] — earlier schedule; done tasks keep their slot
//   notBefore:        { taskId: ISO } — earliest start for a task (a skipped task waits until
//                     its old slot is over instead of landing right back at now)
//
// placements are { taskId, start, end } (local ISO, minute precision), sorted by start.
// unscheduled lists task ids that could not be placed ("didn't fit this week").

const MINUTE = 60 * 1000;

export const DEFAULTS = Object.freeze({
  bufferMinutes: 5,
  dailyCapMinutes: 120,
  horizonDays: 7,
});

export function schedule(tasks, freeWindows, now, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const status = opts.status ?? {};
  const bufferMs = opts.bufferMinutes * MINUTE;
  const nowMs = ceilToMinute(toMs(now));
  const horizonEnd = localMidnightAfter(nowMs, opts.horizonDays + 1);

  const deadlineByGoal = new Map();
  for (const g of opts.goals ?? []) {
    if (g.deadline) deadlineByGoal.set(g.id, parseDeadline(g.deadline));
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const isDone = (id) => status[id] === 'done';

  // Done tasks keep their earlier slot: it blocks time and counts toward that day's cap.
  const fixed = (opts.previous ?? [])
    .filter((p) => isDone(p.taskId) && taskById.has(p.taskId))
    .map((p) => ({ taskId: p.taskId, start: toMs(p.start), end: toMs(p.end) }));

  let free = mergeIntervals(
    freeWindows
      .map((w) => ({ start: Math.max(toMs(w.start), nowMs), end: Math.min(toMs(w.end), horizonEnd) }))
      .filter((w) => w.end > w.start),
  );

  const dayUsage = new Map();
  const endById = new Map();
  for (const p of fixed) {
    free = subtract(free, p.start, p.end + bufferMs);
    addUsage(dayUsage, p.start, (p.end - p.start) / MINUTE);
    endById.set(p.taskId, p.end);
  }

  const pending = tasks.filter((t) => !isDone(t.id));
  const order = orderTasks(pending, taskById, isDone, deadlineByGoal);

  const placements = [];
  const unscheduled = [];
  const failed = new Set();

  for (const task of order.ordered) {
    const deps = knownDeps(task, taskById);
    if (deps.some((d) => failed.has(d))) {
      failed.add(task.id);
      unscheduled.push(task.id);
      continue;
    }
    let earliest = nowMs;
    if (opts.notBefore?.[task.id]) earliest = Math.max(earliest, toMs(opts.notBefore[task.id]));
    for (const d of deps) {
      if (endById.has(d)) earliest = Math.max(earliest, endById.get(d));
    }
    const deadline = deadlineByGoal.get(task.goalId) ?? Infinity;
    const slot = findSlot(free, earliest, task.minutes, bufferMs, deadline, dayUsage, opts.dailyCapMinutes);
    if (!slot) {
      failed.add(task.id);
      unscheduled.push(task.id);
      continue;
    }
    free = subtract(free, slot.start, slot.end + bufferMs);
    addUsage(dayUsage, slot.start, task.minutes);
    endById.set(task.id, slot.end);
    placements.push({ taskId: task.id, start: slot.start, end: slot.end });
  }

  // Leftovers from a dependency cycle (validate.js should have broken it already).
  unscheduled.push(...order.stuck.map((t) => t.id));

  const all = [...fixed, ...placements]
    .sort((a, b) => a.start - b.start)
    .map((p) => ({ taskId: p.taskId, start: formatLocal(p.start), end: formatLocal(p.end) }));

  return { placements: all, unscheduled };
}

// Topological order with round-robin across goals among ready tasks.
// Goals rotate in deadline order (earliest first, no deadline last), then first appearance.
// Within a goal, the earliest task in the original list goes first.
function orderTasks(pending, taskById, isDone, deadlineByGoal) {
  const index = new Map(pending.map((t, i) => [t.id, i]));
  const goalFirstIndex = new Map();
  pending.forEach((t, i) => {
    if (!goalFirstIndex.has(t.goalId)) goalFirstIndex.set(t.goalId, i);
  });
  const goalOrder = [...goalFirstIndex.keys()].sort((a, b) => {
    const da = deadlineByGoal.get(a) ?? Infinity;
    const db = deadlineByGoal.get(b) ?? Infinity;
    if (da !== db) return da - db;
    return goalFirstIndex.get(a) - goalFirstIndex.get(b);
  });

  const remaining = new Set(pending.map((t) => t.id));
  const ordered = [];
  let lastGoal = -1;

  while (remaining.size > 0) {
    const ready = pending.filter(
      (t) => remaining.has(t.id) && knownDeps(t, taskById).every((d) => isDone(d) || !remaining.has(d)),
    );
    if (ready.length === 0) break;

    // Next goal after the last one picked that has a ready task.
    let pick = null;
    for (let step = 1; step <= goalOrder.length && !pick; step++) {
      const gi = (lastGoal + step) % goalOrder.length;
      const candidates = ready.filter((t) => t.goalId === goalOrder[gi]);
      if (candidates.length > 0) {
        pick = candidates.reduce((a, b) => (index.get(a.id) < index.get(b.id) ? a : b));
        lastGoal = gi;
      }
    }
    ordered.push(pick);
    remaining.delete(pick.id);
  }

  return { ordered, stuck: pending.filter((t) => remaining.has(t.id)) };
}

// Earliest start in a free interval at/after `earliest` where minutes + buffer fit,
// the task ends by the deadline, and the day's cap is not exceeded.
function findSlot(free, earliest, minutes, bufferMs, deadline, dayUsage, cap) {
  const durMs = minutes * MINUTE;
  for (const w of free) {
    let start = Math.max(w.start, earliest);
    // A window can span midnight: if today's cap is full, retry from the next local midnight.
    while (start + durMs + bufferMs <= w.end) {
      if (start + durMs > deadline) return null; // later starts only end later
      if ((dayUsage.get(dayKey(start)) ?? 0) + minutes <= cap) return { start, end: start + durMs };
      start = localMidnightAfter(start, 1);
    }
  }
  return null;
}

function knownDeps(task, taskById) {
  return (task.dependsOn ?? []).filter((d) => taskById.has(d));
}

function addUsage(dayUsage, startMs, minutes) {
  const k = dayKey(startMs);
  dayUsage.set(k, (dayUsage.get(k) ?? 0) + minutes);
}

// Sort and merge overlapping or exactly touching intervals.
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

function subtract(free, start, end) {
  const out = [];
  for (const w of free) {
    if (end <= w.start || start >= w.end) {
      out.push(w);
      continue;
    }
    if (w.start < start) out.push({ start: w.start, end: start });
    if (end < w.end) out.push({ start: end, end: w.end });
  }
  return out;
}

// --- time helpers (all local time; Date handles DST) ---

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  // Date-time strings without an offset are parsed as local time.
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${value}`);
  return ms;
}

function ceilToMinute(ms) {
  return Math.ceil(ms / MINUTE) * MINUTE;
}

// Local midnight `days` calendar days after the day containing ms.
function localMidnightAfter(ms, days) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

function parseDeadline(deadline) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    const [y, m, d] = deadline.split('-').map(Number);
    return new Date(y, m - 1, d + 1).getTime(); // end of that local day
  }
  return toMs(deadline);
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatLocal(ms) {
  const d = new Date(ms);
  return `${dayKey(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
