// Prompt builders. Each returns an Ollama `messages` array.
// Design notes and sample outputs: prompt-lab/call2-claude.md.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const PLAN_SYSTEM = `You turn a person's brain-dump into small, concrete tasks. This person gets overwhelmed by big pieces of work, so every task must be something they can start without thinking.

Reply with JSON only, matching the schema.

GOALS
- One goal for each thing the person wants to get done. Never invent goals.
- title: a short name in English, close to the person's own words.
- deadlineText: copy the exact words from the brain-dump that give this goal's deadline, in the person's own language ("by Monday", "due next Friday", "kal tak"). If the person gave no deadline for this goal, use null. Never invent one.
- deadline: the CALENDAR date that deadlineText points to; null when deadlineText is null. "Next Friday" or "next week" means the days under "Next week"; "by next week" means the last day under "Next week". "This month" means the day marked "end of this month". Hindi words: "aaj" is today, "kal" is tomorrow, "parso" is the day after tomorrow.
- estimatedMinutes: an honest guess of the total time to finish the whole goal. Big goals take hours: a thesis chapter or an essay is often 4 to 8 hours (240 to 480 minutes).
- Ignore free time and availability ("free after 7", "weekends work"). Another step handles that.

TASKS
- Tasks must cover the whole goal, from the first step until it is done. Their minutes should add up to about the goal's estimatedMinutes. A big goal needs many tasks; never stop after one or two.
- title: one physical action that starts with a verb: open, write, list, email, call, print, put, take. Never use: work on, research, think about, prepare, finalize, plan.
- Each title must make sense alone on a to-do list. Name the thing: "Email the resume PDF to Priya", not "Send it".
- minutes: an honest estimate, never more than the max minutes in the message. If an action takes longer, split it into several tasks.
- The first task of every goal has isFirstStep true, takes 5 to 10 minutes and has no dependsOn. It is the easiest possible way in: open the file, put the form on the desk, write one line. Every other task has isFirstStep false.
- dependsOn lists the ids of tasks that must be finished first. Every other task in a goal depends on that goal's first step, directly or through another task. Only chain tasks that really need each other.
- List each goal's tasks in the order they would be done. Task ids are t1, t2, t3... across the whole plan. Goal ids are g1, g2...
- At most 12 tasks per goal. If a goal needs more, make task 12 "Write the next steps for <goal>".
- If a goal is vague ("sort my life out"), give only 3 or 4 tasks that make it concrete: write things down, pick one, write its next step. This rule wins over estimatedMinutes and covering the whole goal; set estimatedMinutes to the time of those tasks.
- If the person already listed steps, keep their steps in their order. Split the big ones. If their first step is not tiny, add a tiny first step before it.
- Always write titles in English, even if the person writes in Hindi or Hinglish.
- No advice, no motivation, no extra fields.

EXAMPLE
Message: max 25 minutes per task, today is Thursday 2026-03-12, brain-dump "essay on climate policy due next wednesday, 2000 words. also want to start guitar"
Reply:
{"goals":[{"id":"g1","title":"Climate policy essay","deadlineText":"due next wednesday","deadline":"2026-03-18","estimatedMinutes":240},{"id":"g2","title":"Start guitar","deadlineText":null,"deadline":null,"estimatedMinutes":45}],"tasks":[{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Open a new document and type the essay title and three section headings","minutes":5,"dependsOn":[]},{"id":"t2","goalId":"g1","isFirstStep":false,"title":"List 5 sources on climate policy in the essay document","minutes":25,"dependsOn":["t1"]},{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Write 3 bullet points under each essay heading","minutes":20,"dependsOn":["t1"]},{"id":"t4","goalId":"g1","isFirstStep":false,"title":"Write the essay introduction, about 250 words","minutes":25,"dependsOn":["t3"]},{"id":"t5","goalId":"g1","isFirstStep":false,"title":"Write 400 words for the first essay section","minutes":25,"dependsOn":["t2","t3"]},{"id":"t6","goalId":"g1","isFirstStep":false,"title":"Write 400 words for the second essay section","minutes":25,"dependsOn":["t5"]},{"id":"t7","goalId":"g1","isFirstStep":false,"title":"Write 400 words for the third essay section","minutes":25,"dependsOn":["t6"]},{"id":"t8","goalId":"g1","isFirstStep":false,"title":"Write the essay conclusion, about 250 words","minutes":20,"dependsOn":["t7"]},{"id":"t9","goalId":"g1","isFirstStep":false,"title":"Add a citation for every source used in the essay","minutes":20,"dependsOn":["t8"]},{"id":"t10","goalId":"g1","isFirstStep":false,"title":"Read the essay aloud and fix every sentence that sounds wrong","minutes":25,"dependsOn":["t9"]},{"id":"t11","goalId":"g1","isFirstStep":false,"title":"Check the essay word count and trim or add to reach 2000 words","minutes":15,"dependsOn":["t10"]},{"id":"t12","goalId":"g1","isFirstStep":false,"title":"Upload the essay file to the course portal","minutes":5,"dependsOn":["t11"]},{"id":"t13","goalId":"g2","isFirstStep":true,"title":"Take the guitar out of its case and tune it with a phone app","minutes":10,"dependsOn":[]},{"id":"t14","goalId":"g2","isFirstStep":false,"title":"Watch one beginner video and copy the G chord","minutes":20,"dependsOn":["t13"]},{"id":"t15","goalId":"g2","isFirstStep":false,"title":"Practise switching between the G and C chords","minutes":15,"dependsOn":["t14"]}]}`;

export const SPLIT_SYSTEM = `You split one task into smaller steps. Each step is one physical action that starts with a verb (open, write, list, email, call, put), makes sense alone on a to-do list, and takes no more than the given minutes. Put the steps in the order they would be done. Together the steps must cover the whole task. Always write in English. Reply with JSON only.`;

export const FIRST_STEP_SYSTEM = `You write the tiny first step for a goal: the easiest physical action that gets the person started, taking 5 to 10 minutes and starting with a verb (open, put, write one line, take out). It comes before the task you are shown and makes that task easier; it does not do the task. The title names the real action and the real thing, never just "first step" or "tiny step". Always write in English. Reply with JSON only.

EXAMPLE
Message: Goal: Thesis chapter 3. First task (too big to start with): Write the introduction for chapter 3 (25 min)
Reply: {"title":"Open the chapter 3 file and type the heading Introduction","minutes":5}`;

export const ENGLISH_SYSTEM = `You rewrite to-do items in plain English. Some are written in Hindi or Hinglish. Keep the meaning and every detail (names, amounts, places). Keep each one a short action that starts with a verb, except goal names, which stay short names. Return every id you are given, with its English title. Reply with JSON only.`;

// Call 2. `feedback` is the validation error from a failed first attempt, appended for the retry.
export function planMessages({ brainDump, maxMinutes, today }, feedback = null) {
  const user = [
    `Today: ${weekdayOf(today)} ${today}`,
    `Max minutes per task: ${maxMinutes}`,
    '',
    'CALENDAR',
    buildCalendar(today),
    '',
    'BRAIN-DUMP',
    brainDump.trim(),
  ];
  if (feedback) user.push('', feedback);
  return [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: user.join('\n') },
  ];
}

export function splitMessages(task, maxMinutes, goal) {
  return [
    { role: 'system', content: SPLIT_SYSTEM },
    {
      role: 'user',
      content: `Goal: ${goal?.title ?? ''}\nTask: ${task.title} (${task.minutes} min)\nSplit this into steps of at most ${maxMinutes} minutes.`,
    },
  ];
}

export function firstStepMessages(task, goal) {
  return [
    { role: 'system', content: FIRST_STEP_SYSTEM },
    {
      role: 'user',
      content: `Goal: ${goal?.title ?? ''}\nFirst task (too big to start with): ${task.title} (${task.minutes} min)\nWrite a tiny step to do before it, 10 minutes or less.`,
    },
  ];
}

// items: [{ id, title }]
export function englishMessages(items) {
  return [
    { role: 'system', content: ENGLISH_SYSTEM },
    { role: 'user', content: items.map((i) => `${i.id}: ${i.title}`).join('\n') },
  ];
}

// Dates the model can copy instead of doing date arithmetic. Weeks run Monday to Sunday.
//   This week:
//   Fri 2026-10-02 (today)
//   Sat 2026-10-03 (tomorrow)
//   ...
//   Next week:
//   Mon 2026-10-05
//   ...
//   Later:
//   Sat 2026-10-31 (end of this month)
export function buildCalendar(today, days = 35) {
  const start = parseDate(today);
  const first = new Date(start);
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const lastOfMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getTime();

  const lines = [];
  let section = null;
  for (let i = 0; i < days; i++) {
    const ms = start + i * DAY_MS;
    const week = Math.floor((mondayOffset + i) / 7);
    const heading = week === 0 ? 'This week' : week === 1 ? 'Next week' : 'Later';
    if (heading !== section) {
      lines.push(`${heading}:`);
      section = heading;
    }
    const labels = [];
    if (i === 0) labels.push('today');
    if (i === 1) labels.push('tomorrow');
    if (ms === lastOfMonth) labels.push('end of this month');
    const d = new Date(ms);
    lines.push(`${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${formatDate(ms)}${labels.length ? ` (${labels.join(', ')})` : ''}`);
  }
  return lines.join('\n');
}

export function weekdayOf(date) {
  return WEEKDAYS[new Date(parseDate(date)).getUTCDay()];
}

// Calendar dates as UTC midnights: no DST, so stepping by 24h is exact.
function parseDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
