# Call 2 design: Claude's answer

Written by Claude (Opus 5.5) in the Claude Code session that built `validate.js`, so it had more context than a fresh chat given only `call2-meta-prompt.md`.

**Chosen design.** The code in `src/llm/prompts.js` and `src/llm/schemas.js` is now the source of truth; this file keeps the reasoning and sample outputs.

## 1. CALL 2 SYSTEM PROMPT

```text
You turn a person's brain-dump into small, concrete tasks. This person gets overwhelmed by big pieces of work, so every task must be something they can start without thinking.

Reply with JSON only, matching the schema.

GOALS
- One goal for each thing the person wants to get done. Never invent goals.
- title: a short name in English, close to the person's own words.
- deadline: if the person states or implies a deadline, copy the matching date from the CALENDAR in the message. "Next Friday" or "next week" means the days under "Next week"; "by next week" means the last day under "Next week". "This month" means the day marked "end of this month". If no deadline is given, use null. Never guess one.
- Ignore free time and availability ("free after 7", "weekends work"). Another step handles that.

TASKS
- title: one physical action that starts with a verb: open, write, list, email, call, print, put, take. Never use: work on, research, think about, prepare, finalize, plan.
- Each title must make sense alone on a to-do list. Name the thing: "Email the resume PDF to Priya", not "Send it".
- minutes: an honest estimate, never more than the max minutes in the message. If an action takes longer, split it into several tasks.
- The first task of every goal has isFirstStep true, takes 5 to 10 minutes and has no dependsOn. It is the easiest possible way in: open the file, put the form on the desk, write one line. Every other task has isFirstStep false.
- dependsOn lists the ids of tasks that must be finished first. Every other task in a goal depends on that goal's first step, directly or through another task. Only chain tasks that really need each other.
- List each goal's tasks in the order they would be done. Task ids are t1, t2, t3... across the whole plan. Goal ids are g1, g2...
- At most 12 tasks per goal. If a goal needs more, make task 12 "Write the next steps for <goal>".
- If a goal is vague ("sort my life out"), give 3 or 4 tasks that make it concrete: write things down, pick one, write its next step.
- If the person already listed steps, keep their steps in their order. Split the big ones. If their first step is not tiny, add a tiny first step before it.
- Always write titles in English, even if the person writes in Hindi or Hinglish.
- No advice, no motivation, no extra fields.

EXAMPLE
Message: max 20 minutes per task, today is Thursday 2026-03-12, brain-dump "clear out the garage before sunday. also want to start guitar"
Reply:
{"goals":[{"id":"g1","title":"Clear out the garage","deadline":"2026-03-15"},{"id":"g2","title":"Start guitar","deadline":null}],"tasks":[{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Put three boxes in the garage labelled keep, give and bin","minutes":10,"dependsOn":[]},{"id":"t2","goalId":"g1","isFirstStep":false,"title":"Sort everything on the garage's left wall into the three boxes","minutes":20,"dependsOn":["t1"]},{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Sort everything on the garage's right wall into the three boxes","minutes":20,"dependsOn":["t1"]},{"id":"t4","goalId":"g1","isFirstStep":false,"title":"Take the garage bin box out to the trash","minutes":10,"dependsOn":["t2","t3"]},{"id":"t5","goalId":"g2","isFirstStep":true,"title":"Take the guitar out of its case and tune it with a phone app","minutes":10,"dependsOn":[]},{"id":"t6","goalId":"g2","isFirstStep":false,"title":"Watch one beginner video and copy the G chord","minutes":20,"dependsOn":["t5"]},{"id":"t7","goalId":"g2","isFirstStep":false,"title":"Practise switching between the G and C chords","minutes":15,"dependsOn":["t6"]}]}
```

## 2. CALL 2 USER MESSAGE TEMPLATE

```text
Today: {weekday} {today}
Max minutes per task: {maxMinutes}

CALENDAR
{calendar}

BRAIN-DUMP
{brainDump}
```

`{calendar}` is an extra input that code generates from `{today}` (`buildCalendar` in `src/llm/prompts.js`). It lists the next 35 days, grouped by Monday-to-Sunday weeks, so the model copies a date instead of doing date arithmetic:

```text
This week:
Fri 2026-10-02 (today)
Sat 2026-10-03 (tomorrow)
Sun 2026-10-04
Next week:
Mon 2026-10-05
...
Fri 2026-10-09
Sun 2026-10-11
Later:
...
Sat 2026-10-31 (end of this month)
...
```

## 3. CALL 2 JSON SCHEMA

```json
{
  "type": "object",
  "properties": {
    "goals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "deadline": { "type": ["string", "null"] }
        },
        "required": ["id", "title", "deadline"],
        "additionalProperties": false
      }
    },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "goalId": { "type": "string" },
          "isFirstStep": { "type": "boolean" },
          "title": { "type": "string" },
          "minutes": { "type": "integer" },
          "dependsOn": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["id", "goalId", "isFirstStep", "title", "minutes", "dependsOn"],
        "additionalProperties": false
      }
    }
  },
  "required": ["goals", "tasks"],
  "additionalProperties": false
}
```

## 4. FOLLOW-UP A: split task

System:
```text
You split one task into smaller steps. Each step is one physical action that starts with a verb (open, write, list, email, call, put), makes sense alone on a to-do list, and takes no more than the given minutes. Put the steps in the order they would be done. Together the steps must cover the whole task. Always write in English. Reply with JSON only.
```

User template:
```text
Goal: {goalTitle}
Task: {title} ({minutes} min)
Split this into steps of at most {maxMinutes} minutes.
```

Schema:
```json
{
  "type": "object",
  "properties": {
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "minutes": { "type": "integer" }
        },
        "required": ["title", "minutes"],
        "additionalProperties": false
      }
    }
  },
  "required": ["steps"],
  "additionalProperties": false
}
```

## 5. FOLLOW-UP B: smaller first step

System:
```text
You write the tiny first step for a goal: the easiest physical action that gets the person started, taking 5 to 10 minutes and starting with a verb (open, put, write one line, take out). It comes before the task you are shown and makes that task easier; it does not do the task. Always write in English. Reply with JSON only.
```

User template:
```text
Goal: {goalTitle}
First task (too big to start with): {title} ({minutes} min)
Write a tiny step to do before it, 10 minutes or less.
```

Schema:
```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "minutes": { "type": "integer" }
  },
  "required": ["title", "minutes"],
  "additionalProperties": false
}
```

The tiny step is inserted **before** the oversized task, which stays as the next task. If the model can't help, code splits the task into a 10-minute start and the rest. Either way no work is lost.

## 5b. FOLLOW-UP C: English rewrite (added after the comparison)

Code flags any goal or task title in Hindi script or using common Hinglish words (`looksNonEnglish` in `validate.js`). It sends all flagged titles in one batch and accepts a rewrite only if it passes the same check. It tries at most twice.

System:
```text
You rewrite to-do items in plain English. Some are written in Hindi or Hinglish. Keep the meaning and every detail (names, amounts, places). Keep each one a short action that starts with a verb, except goal names, which stay short names. Return every id you are given, with its English title. Reply with JSON only.
```

User template: one line per item, `{id}: {title}`, ids like `goal:g1` and `task:t3`.

Schema: `{"titles": [{"id": "...", "title": "..."}]}` (see `ENGLISH_SCHEMA`).

## 6. DESIGN NOTES

- **A calendar instead of date arithmetic.** Small models are bad at working out "next Friday" from "today is Friday". Code lists the next 35 days with labels, so the model only has to copy a date. This adds one input beyond the four in the meta-prompt.
- **Property order steers generation.** Goals come before tasks so `goalId` values refer to goals that already exist. Inside a task, `isFirstStep` comes before `title`, so the model has committed to "this is the tiny one" before writing it. `title` comes before `minutes`, so the estimate is based on the action just written. `dependsOn` comes last and only points back to ids that already exist.
- **One few-shot example, in an unrelated domain** (garage, guitar). It shows the JSON layout, the first-step style, standalone titles and partial chaining. Being unrelated keeps the model from copying content into the real plan. One example is enough; more makes a small model's context longer and its copying worse.
- **Rules as short bullets with banned words listed.** Naming the abstractions to avoid ("work on", "research") works better on 7-8B models than "be concrete".
- **"Every other task depends on the first step."** This guarantees the scheduler puts the easy start first, without forcing a full chain over tasks that are independent.
- **12-task cap per goal.** It keeps outputs short (faster and fewer late-JSON mistakes on 8B models), and a "Write the next steps" task stands in for the rest.
- **The schema has no numeric bounds and no patterns,** as required. `additionalProperties: false` stops the model adding commentary fields.
- **Titles are always English,** even for Hindi or Hinglish input. 8B models write English more reliably than Hinglish. Revisit once the friend has tried it.
- **Follow-up prompts repeat the title rules** because each is a fresh call with no memory of the main prompt.
- **English is enforced by code too,** not only by the prompt (follow-up C), because small models drift back into the input language.

## 7. EXPECTED FAILURE MODES

- **Vague titles slipping through**, such as "Review the chapter" or "Organize documents". Check every title for "could I start this right now without deciding anything?"
- **Invented structure:** "2 DSA questions", "3 sections" in a chapter the model hasn't seen. Mostly harmless, but it can look wrong to the friend. Watch test 3.
- **Deadline mistakes:** "next Friday" read as today, "this month" left null, and deadlines invented for goals without one (test 3's room cleaning).
- **Planning availability:** a goal or task like "Free on weekday evenings" appearing from test 3's first sentence.
- **Every task at exactly `maxMinutes`,** as if the model just filled the slider value. Check that estimates vary.
- **Hinglish misread or left untranslated:** with Hinglish input, check that every title comes out in English and that nothing is lost ("kal tak" read as tomorrow, "mummy ke liye" kept as "for Mom").
- **Over-chaining:** every task depends on the previous one. That's valid, but it limits interleaving and pushes work later.
- **Llama-specific:** may break the id convention or restart t1 per goal. Code catches duplicate ids, but that costs a retry.

## 8. SAMPLE OUTPUTS (today 2026-10-02 Friday, maxMinutes 25)

### Test 1: "get my life together"

```json
{"goals":[{"id":"g1","title":"Get my life together","deadline":null}],"tasks":[
{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Take a sheet of paper and write down everything on your mind","minutes":10,"dependsOn":[]},
{"id":"t2","goalId":"g1","isFirstStep":false,"title":"Circle the 3 things on your list that bother you most","minutes":5,"dependsOn":["t1"]},
{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Pick one circled thing and write down its very next step","minutes":5,"dependsOn":["t2"]},
{"id":"t4","goalId":"g1","isFirstStep":false,"title":"Type the circled things into this planner as new goals","minutes":10,"dependsOn":["t2"]}
]}
```

### Test 2: thesis, resume, passport

```json
{"goals":[
{"id":"g1","title":"Thesis chapter 3","deadline":"2026-10-09"},
{"id":"g2","title":"Resume to Priya","deadline":"2026-10-05"},
{"id":"g3","title":"Renew my passport","deadline":"2026-10-31"}],"tasks":[
{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Open the chapter 3 file and write the section headings","minutes":5,"dependsOn":[]},
{"id":"t2","goalId":"g1","isFirstStep":false,"title":"Write 3 bullet points under each chapter 3 heading","minutes":20,"dependsOn":["t1"]},
{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Write 300 words for the first section of chapter 3","minutes":25,"dependsOn":["t2"]},
{"id":"t4","goalId":"g1","isFirstStep":false,"title":"Write 300 words for the second section of chapter 3","minutes":25,"dependsOn":["t3"]},
{"id":"t5","goalId":"g1","isFirstStep":false,"title":"Write 300 words for the third section of chapter 3","minutes":25,"dependsOn":["t4"]},
{"id":"t6","goalId":"g1","isFirstStep":false,"title":"Add the missing citations to chapter 3","minutes":20,"dependsOn":["t5"]},
{"id":"t7","goalId":"g1","isFirstStep":false,"title":"Read chapter 3 start to end and fix 10 clumsy sentences","minutes":25,"dependsOn":["t6"]},
{"id":"t8","goalId":"g1","isFirstStep":false,"title":"Export chapter 3 as a PDF and save a backup copy","minutes":5,"dependsOn":["t7"]},
{"id":"t9","goalId":"g2","isFirstStep":true,"title":"Open your resume file and read it once","minutes":5,"dependsOn":[]},
{"id":"t10","goalId":"g2","isFirstStep":false,"title":"Mark every line on your resume that is out of date","minutes":10,"dependsOn":["t9"]},
{"id":"t11","goalId":"g2","isFirstStep":false,"title":"Rewrite the marked lines on your resume","minutes":20,"dependsOn":["t10"]},
{"id":"t12","goalId":"g2","isFirstStep":false,"title":"Add your latest project or job to your resume","minutes":20,"dependsOn":["t9"]},
{"id":"t13","goalId":"g2","isFirstStep":false,"title":"Export your resume as a PDF and check it looks right","minutes":5,"dependsOn":["t11","t12"]},
{"id":"t14","goalId":"g2","isFirstStep":false,"title":"Email the resume PDF to Priya","minutes":5,"dependsOn":["t13"]},
{"id":"t15","goalId":"g3","isFirstStep":true,"title":"Open the passport renewal website and find the renewal form","minutes":10,"dependsOn":[]},
{"id":"t16","goalId":"g3","isFirstStep":false,"title":"List the documents the passport renewal form asks for","minutes":10,"dependsOn":["t15"]},
{"id":"t17","goalId":"g3","isFirstStep":false,"title":"Put all the passport documents in one folder","minutes":15,"dependsOn":["t16"]},
{"id":"t18","goalId":"g3","isFirstStep":false,"title":"Fill in the online passport renewal form","minutes":25,"dependsOn":["t17"]},
{"id":"t19","goalId":"g3","isFirstStep":false,"title":"Book the passport appointment slot and save the confirmation","minutes":10,"dependsOn":["t18"]}
]}
```

### Test 3: room and DSA (availability sentence ignored)

```json
{"goals":[
{"id":"g1","title":"Clean my room","deadline":null},
{"id":"g2","title":"Finish the DSA assignment","deadline":"2026-10-06"}],"tasks":[
{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Put a bin bag by your bedroom door","minutes":5,"dependsOn":[]},
{"id":"t2","goalId":"g1","isFirstStep":false,"title":"Put every bit of trash in your room into the bin bag","minutes":10,"dependsOn":["t1"]},
{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Put all your clothes in the laundry basket or the wardrobe","minutes":15,"dependsOn":["t1"]},
{"id":"t4","goalId":"g1","isFirstStep":false,"title":"Clear everything off your desk and wipe it","minutes":15,"dependsOn":["t1"]},
{"id":"t5","goalId":"g1","isFirstStep":false,"title":"Make the bed and vacuum your room floor","minutes":20,"dependsOn":["t2","t3"]},
{"id":"t6","goalId":"g2","isFirstStep":true,"title":"Open the DSA assignment and read the first question","minutes":5,"dependsOn":[]},
{"id":"t7","goalId":"g2","isFirstStep":false,"title":"List every DSA assignment question and what you must submit","minutes":10,"dependsOn":["t6"]},
{"id":"t8","goalId":"g2","isFirstStep":false,"title":"Solve DSA question 1 on paper","minutes":25,"dependsOn":["t7"]},
{"id":"t9","goalId":"g2","isFirstStep":false,"title":"Code and test your DSA question 1 solution","minutes":25,"dependsOn":["t8"]},
{"id":"t10","goalId":"g2","isFirstStep":false,"title":"Solve DSA question 2 on paper","minutes":25,"dependsOn":["t7"]},
{"id":"t11","goalId":"g2","isFirstStep":false,"title":"Code and test your DSA question 2 solution","minutes":25,"dependsOn":["t10"]},
{"id":"t12","goalId":"g2","isFirstStep":false,"title":"Zip your DSA code and submit it on the portal","minutes":10,"dependsOn":["t9","t11"]}
]}
```

### Test 4: portfolio (user's own steps kept)

```json
{"goals":[{"id":"g1","title":"Portfolio site","deadline":null}],"tasks":[
{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Open 3 portfolio templates in browser tabs","minutes":5,"dependsOn":[]},
{"id":"t2","goalId":"g1","isFirstStep":false,"title":"Pick one portfolio template and copy it into a new GitHub repo","minutes":15,"dependsOn":["t1"]},
{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Write a 5-line draft of your About page","minutes":15,"dependsOn":["t1"]},
{"id":"t4","goalId":"g1","isFirstStep":false,"title":"Paste your About text into the portfolio site and preview it","minutes":10,"dependsOn":["t2","t3"]},
{"id":"t5","goalId":"g1","isFirstStep":false,"title":"Take screenshots of your first portfolio project","minutes":10,"dependsOn":["t1"]},
{"id":"t6","goalId":"g1","isFirstStep":false,"title":"Add project 1 to the portfolio with its screenshot and 2 lines of text","minutes":20,"dependsOn":["t2","t5"]},
{"id":"t7","goalId":"g1","isFirstStep":false,"title":"Take screenshots of your second portfolio project","minutes":10,"dependsOn":["t1"]},
{"id":"t8","goalId":"g1","isFirstStep":false,"title":"Add project 2 to the portfolio with its screenshot and 2 lines of text","minutes":20,"dependsOn":["t2","t7"]},
{"id":"t9","goalId":"g1","isFirstStep":false,"title":"Take screenshots of your third portfolio project","minutes":10,"dependsOn":["t1"]},
{"id":"t10","goalId":"g1","isFirstStep":false,"title":"Add project 3 to the portfolio with its screenshot and 2 lines of text","minutes":20,"dependsOn":["t2","t9"]},
{"id":"t11","goalId":"g1","isFirstStep":false,"title":"Turn on GitHub Pages in the portfolio repo settings","minutes":10,"dependsOn":["t4","t6","t8","t10"]},
{"id":"t12","goalId":"g1","isFirstStep":false,"title":"Open the live portfolio site and click through every page","minutes":10,"dependsOn":["t11"]}
]}
```

### Test 5: Hinglish input, English titles

```json
{"goals":[
{"id":"g1","title":"Pay the electricity bill","deadline":"2026-10-03"},
{"id":"g2","title":"Start a gym routine","deadline":"2026-10-04"},
{"id":"g3","title":"Book Mom's doctor appointment","deadline":null}],"tasks":[
{"id":"t1","goalId":"g1","isFirstStep":true,"title":"Open the electricity bill app or website","minutes":5,"dependsOn":[]},
{"id":"t2","goalId":"g1","isFirstStep":false,"title":"Check the electricity bill amount and due date","minutes":5,"dependsOn":["t1"]},
{"id":"t3","goalId":"g1","isFirstStep":false,"title":"Pay the electricity bill and screenshot the receipt","minutes":10,"dependsOn":["t2"]},
{"id":"t4","goalId":"g2","isFirstStep":true,"title":"Put shoes, a towel and a water bottle in your gym bag","minutes":5,"dependsOn":[]},
{"id":"t5","goalId":"g2","isFirstStep":false,"title":"Look up the nearest gym's timings and fees on your phone","minutes":10,"dependsOn":["t4"]},
{"id":"t6","goalId":"g2","isFirstStep":false,"title":"Go to the gym and do a light 20-minute workout","minutes":25,"dependsOn":["t5"]},
{"id":"t7","goalId":"g3","isFirstStep":true,"title":"Ask Mom which doctor she wants to see and when she is free","minutes":5,"dependsOn":[]},
{"id":"t8","goalId":"g3","isFirstStep":false,"title":"Find the doctor's clinic number or open the booking app","minutes":5,"dependsOn":["t7"]},
{"id":"t9","goalId":"g3","isFirstStep":false,"title":"Call to book Mom's doctor appointment and add the time to your calendar","minutes":10,"dependsOn":["t8"]}
]}
```

Test 5 also shows a limit: "weekend pe gym routine" is a recurring habit, and the app has no concept of repeats. The best this plan can do is get the first session started by Sunday.
