You are helping me design the prompts and JSON schemas for one LLM call in a small web app. The output must work well with a LOCAL 7-8B instruct model (qwen3:8b with thinking off, or llama3.1:8b) running on Ollama at temperature 0. Design for a small model, not for yourself: short, explicit, example-driven.

## The app
A privacy-first planner for one friend who gets overwhelmed by large pieces of work. They type a brain-dump of goals and free time in plain language, for example: "finish thesis chapter by Friday, fix resume, I'm free after 7 on weekdays and Saturday morning". They pick a task size with a slider (maxMinutes, 10-60, default 25). The app turns this into small tasks and schedules them. The real problem is overwhelm, not scheduling: every task must be small and concrete enough to start without thinking.

## Division of labour (important)
- The model does the fuzzy work: splitting goals into tasks and reading deadlines.
- Code does everything exact. After the model responds, code already:
  - enforces minutes <= maxMinutes (sends oversized tasks back for splitting, then hard-splits)
  - clamps each goal's first step to <= 10 min
  - sets minutes to at least 5
  - drops unknown or self dependsOn ids and breaks cycles
  - does all scheduling and time arithmetic
- Availability ("free after 7 on weekdays") is extracted by a SEPARATE call. This call must ignore availability and must not schedule anything.
So the prompt should focus on task QUALITY. Don't spend prompt length on rules the code already enforces, beyond a short instruction to respect them.

## The call to design: "Call 2: decompose goals"
Inputs available to the prompt template: {brainDump} (raw text), {maxMinutes} (integer), {today} (YYYY-MM-DD), {weekday} (e.g. Friday).

Required output shape. The parser rejects anything else, so keep these exact field names:
{
  "goals": [ { "id": "g1", "title": "Thesis chapter 3", "deadline": "2026-10-09" } ],
  "tasks": [
    { "id": "t1", "goalId": "g1", "title": "Open the draft and write the section headings", "minutes": 5, "dependsOn": [], "isFirstStep": true },
    { "id": "t2", "goalId": "g1", "title": "Outline the methods section in bullets", "minutes": 25, "dependsOn": ["t1"], "isFirstStep": false }
  ]
}
Rules:
- goal ids g1, g2, ...; task ids t1, t2, ... unique across the whole plan
- deadline is "YYYY-MM-DD" or null. Resolve relative dates ("by Friday", "next week", "end of month") against {today}/{weekday}. Use null if no deadline is stated; never invent one.
- minutes: integer, at most {maxMinutes}
- each goal has exactly one isFirstStep task: trivially small (<= 10 min), no dependencies, a physical action that lowers the barrier to starting (open the file, write one line, put the form on the desk)
- task titles are concrete physical actions starting with a verb ("open", "write", "email", "list", "print"). Never abstractions ("work on", "research", "think about", "prepare", "finalize").
- each title stands alone: it must make sense on a "Today" screen without seeing the goal
- dependsOn only when a task truly needs another finished first; independent tasks should not be chained
- tasks are listed in a sensible working order within each goal
- don't invent goals the person didn't mention. If the person already broke a goal into steps, keep their steps (split only the ones that are too big).
- write titles in the language the person used. For mixed language such as Hinglish, mirror their style.
- no motivational text and no extra fields

The schema is passed to Ollama's `format` parameter, which turns it into a grammar for constrained decoding. Keep the schema to a simple subset: type, properties, required, items, enum, nullable via a type array. Don't use $ref, oneOf/anyOf, patterns or format keywords. Don't rely on minimum/maximum being enforced (code enforces them). Property order in the schema decides generation order, so choose it deliberately and explain why.

## Two small follow-up calls (also design these)
Code makes these when a check fails. Each returns a top-level JSON object.
A) Split task: input is one task (title, minutes) plus its goal title and maxMinutes. Output: {"steps": [{"title": "...", "minutes": 20}, ...]}, steps in order, each <= maxMinutes, same quality rules for titles.
B) Smaller first step: input is the oversized first step plus its goal title. Output: {"title": "...", "minutes": 5}. One tiny starting action, <= 10 min.

## Deliverable: use exactly these sections so I can compare answers side by side
1. CALL 2 SYSTEM PROMPT: the full text, ready to paste
2. CALL 2 USER MESSAGE TEMPLATE: using {brainDump}, {maxMinutes}, {today}, {weekday}
3. CALL 2 JSON SCHEMA: valid JSON, ready to paste
4. FOLLOW-UP A: system prompt, user template, schema
5. FOLLOW-UP B: system prompt, user template, schema
6. DESIGN NOTES: at most 10 bullets covering why it's built this way for a 7-8B model, whether you used a few-shot example and why, and the property-order choice
7. EXPECTED FAILURE MODES: what a 7-8B model will likely still get wrong, and what to look for when testing
8. SAMPLE OUTPUTS: run your Call 2 prompt yourself on the 5 test inputs below (today = 2026-10-02, a Friday; maxMinutes = 25) and show the JSON you'd expect a good answer to produce

Test inputs:
1. "get my life together"
2. "thesis chapter 3 due next Friday, resume to Priya by Monday, and renew my passport sometime this month"
3. "weekday evenings work but not Wednesday. need to clean my room and finish the DSA assignment by Tuesday"
4. "Portfolio site: 1) pick a template 2) write about page 3) add 3 projects with screenshots 4) deploy to GitHub Pages"
5. "kal tak electricity bill pay karna hai, aur weekend pe gym ka routine start karna hai, plus mummy ke liye doctor appointment book karni hai"
