# Hacktoberfest 2026 – Goal-to-Plan Web App: Handoff for Claude Code

Oct 2, 2026 · @Lite

## Context

We are building a privacy-first web app that turns a brain-dump of goals into small, scheduled tasks, for one specific friend who sometimes gets overwhelmed by large pieces of work. It is a submission to the DEV Hacktoberfest 2026 Weekend Challenge, theme "Build for a Friend".

- **Challenge rule that shapes everything:** open-source AI must be at the core (open-weight model, open framework, local inference). The post must explain why the open approach mattered.
- **Judging:** writing quality is weighted most, then relevance to theme, creativity, technical execution. Bonus for handing it to the friend and reporting what they said.
- **The real problem is overwhelm, not scheduling.** Every design choice should reduce the number of decisions and the visible size of the work, not add features.
- **Working title:** TBD (pick one with the friend if possible).

## Product scope

The MVP is text-only: the user types a paragraph of goals and availability, picks a task size, and gets a plan that shows only today's tasks. Calendar import and in-browser inference are stretch goals.

**MVP (must ship)**

1. Brain-dump text box: goals, deadlines and free time in plain language (e.g. "finish thesis chapter by Friday, fix resume, I'm free after 7 on weekdays and Saturday morning").
2. Task-size slider next to the text box, default 25 min, range about 10 to 60 min. Chosen per plan, not buried in settings, so the user can pick a smaller size on a bad day.
3. LLM decomposes goals into tasks; code enforces the size cap; the first task of every goal is trivially small.
4. LLM extracts availability windows from the same text.
5. Deterministic scheduler places tasks into free windows.
6. "Today" view by default (next task highlighted); full plan one click away.
7. Done / Skip per task; skipped tasks re-plan quietly from now. No overdue list, no red.
8. Data persists in browser localStorage. No accounts, no server.

**Stretch (only after MVP works and the friend has tried it)**

- .ics calendar upload: busy events subtracted from free time.
- WebLLM backend so it runs with no Ollama install.
- Live Google Calendar sync via OAuth.

**Non-goals**

- Multi-user, accounts, cloud sync.
- Writing events back into the user's calendar.
- Motivational quotes or research text inside the app (research goes in the post, not the UI).
- Settings pages, checkboxes, onboarding flows.

## Key design decisions

The model does the fuzzy work (breaking goals down, reading free text); plain code does everything exact (time math, scheduling, size limits).

| Decision | Choice | Why |
| --- | --- | --- |
| Who schedules | Deterministic code, never the LLM | Small models are unreliable at time arithmetic and will double-book slots |
| Inference | Local Ollama by default, behind a swappable adapter | Brain-dumps and calendars are personal; nothing goes to an AI provider. Adapter makes WebLLM a drop-in later |
| Model size | 7-8B instruct model (current Qwen or Llama in the Ollama library) | Decomposition quality is the product; 1-3B browser models produce vague subtasks |
| Output format | JSON via Ollama `format` with a JSON schema | Reliable parsing from a small model |
| Task size cap | Slider, enforced in code after the LLM responds | The prompt alone will be ignored sometimes |
| First task | Forced to 10 min or less per goal | Starting is the main blocker; an easy first step lowers it |
| Daily load | Cap total scheduled minutes per day | A day packed with small tasks is still overwhelming |
| Overflow | Tasks that don't fit go to a "didn't fit this week" list | Honest instead of cramming |
| Calendar input | .ics upload, not Google OAuth (for now) | Works with Google, Outlook, Apple; no OAuth setup; cleaner privacy story |
| Storage | localStorage | No backend, no accounts |

Privacy claim to keep honest: model inference stays on the device. Initial model and library downloads still hit public servers. If Google Calendar is used, the data already lives with Google; we only avoid adding a third party.

## Architecture

A static single-page app (no backend) calls a local model through one adapter function; everything after the model's output is plain, tested JavaScript.

&#91;embedded content: app pipeline · 2 LLM calls, 4 code stages\]

Only the two highlighted boxes touch the model; the calendar path (stretch) feeds the scheduler without any LLM call.

**Stack:** Vite, React or plain JS, Vitest, ical.js (stretch), Ollama `/api/chat` with JSON-schema `format`, WebLLM (stretch), hosted on GitHub Pages.

**Suggested layout:**

```
src/
  llm/adapter.js      # complete(messages, schema) -> object; Ollama now, WebLLM later
  llm/prompts.js      # Call 1 and Call 2 prompt builders
  llm/schemas.js      # JSON schemas for both calls
  validate.js         # size cap, first-step clamp, dependency cleanup
  scheduler.js        # pure function, no DOM, no model
  calendar.js         # .ics -> busy intervals -> free windows (stretch)
  storage.js          # localStorage load/save, versioned key
  ui/                 # input + slider, Today view, full plan
tests/
  scheduler.test.js
  validate.test.js
```

## Data model and LLM contracts

There are exactly two LLM calls, each with a fixed JSON schema passed to Ollama's `format` parameter. All times are local ISO 8601 strings; durations are integer minutes.

**Call 1: extract availability** (skipped when a calendar is uploaded). Input: the brain-dump text, today's date and weekday, the user's timezone, and a planning horizon (default 7 days). Output:

```json
{
  "windows": [
    { "start": "2026-10-05T19:00", "end": "2026-10-05T21:00" }
  ],
  "assumptions": ["'evenings' read as 19:00-21:00"]
}
```

Show `assumptions` to the user under the plan so they can correct a misread.

**Call 2: decompose goals.** Input: the brain-dump text, the slider value `maxMinutes`, and today's date. Output:

```json
{
  "goals": [
    { "id": "g1", "title": "Thesis chapter 3", "deadline": "2026-10-09" }
  ],
  "tasks": [
    { "id": "t1", "goalId": "g1", "title": "Open the draft and write the section headings",
      "minutes": 5, "dependsOn": [], "isFirstStep": true },
    { "id": "t2", "goalId": "g1", "title": "Outline the methods section in bullets",
      "minutes": 25, "dependsOn": ["t1"], "isFirstStep": false }
  ]
}
```

Task titles must be concrete physical actions ("open", "write", "email"), not abstractions ("work on", "research").

**App state in localStorage** (one key, e.g. `planner:v1`):

```json
{
  "input": { "text": "...", "maxMinutes": 25 },
  "goals": [], "tasks": [],
  "windows": [], "busy": [],
  "schedule": [ { "taskId": "t1", "start": "...", "end": "..." } ],
  "status": { "t1": "done" },
  "unscheduled": ["t9"]
}
```

**Model adapter:** one function `complete(messages, schema) -> object`. Ollama implementation first (`POST http://localhost:11434/api/chat`, `stream: false`, `format: schema`). WebLLM implementation later behind the same signature.

## Scheduler and validation

The scheduler is a pure function with no model or DOM access: `schedule(tasks, freeWindows, now, options) -> { placements, unscheduled }`. Build and test it first.

**Validation (runs on every Call 2 response, before scheduling)**

1. Parse against the schema; on failure, retry once with the error message appended; on second failure, show a friendly error.
2. Any task with `minutes > maxMinutes`: send that one task back with "split this into steps of at most N minutes" and replace it with the result. Max 2 split rounds, then hard-split by code into equal parts.
3. First task of each goal (`isFirstStep`, or the first task with empty `dependsOn`): clamp to 10 min or less; if the model made it larger, ask for a smaller first step.
4. Drop `dependsOn` references to unknown ids; detect cycles and break them by removing the last edge.
5. Clamp `minutes` to at least 5.

**Scheduling rules**

1. Order tasks topologically by `dependsOn`; tie-break by goal deadline (earliest first), then by original order.
2. Interleave goals where possible so one day isn't all one goal (simple round-robin across goals among ready tasks).
3. Place each task in the earliest free window, at or after `now`, after its dependencies end, that fits `minutes + buffer`.
4. Buffer between tasks: 5 min default.
5. Daily cap: total scheduled minutes per day at most `dailyCapMinutes` (default 120; expose later only if the friend needs it).
6. Tasks that cannot be placed before their goal deadline or within the horizon go to `unscheduled`, shown as "didn't fit this week". Never squeeze.
7. Done tasks are fixed; on Skip or on load after a missed slot, re-run the scheduler for all not-done tasks from `now`.

**Unit tests required:** empty input, single task, dependency chain, tasks larger than any window, daily cap reached, deadline passed, window boundaries exactly touching, timezone and DST edge (late October in many regions), re-plan after skip keeps done tasks.

## Calendar (.ics) handling

Calendar is a stretch goal: parse an uploaded .ics file in the browser with ical.js, turn events into busy intervals, and subtract them from waking hours to get free windows. The rest of the pipeline is unchanged.

- **Waking hours:** default 08:00 to 22:00; the user can mention different hours in the text, which Call 1 can still extract even when a calendar is uploaded.
- **Recurring events are the main trap.** Expand RRULEs with ical.js's iterator across the planning horizon, and apply EXDATE exceptions. Without this, weekly classes or shifts silently disappear and tasks get scheduled over them.
- **All-day events:** treat as busy for the whole day by default (configurable later).
- **Timezones:** convert every event to the user's local zone; test with an export that has a TZID.
- **Merge** overlapping busy intervals before subtracting.
- **Test with a real export** from Google Calendar (Settings, Import and export), not a hand-written file.
- File stays in the browser; never upload it anywhere.

## Build order

Build the parts with no model dependency first, get a rough text-only version in front of the friend by end of day 1, and protect a fixed block on the last day for the write-up.

**Day 1: working text-only planner**

- [ ] Scaffold Vite app (React or plain JS), Vitest, deploy target GitHub Pages
- [ ] `scheduler.js` + full unit test suite with fake tasks and windows
- [ ] `validate.js` (cap enforcement, first-step clamp, dependency cleanup) + tests
- [ ] Model adapter for Ollama; verify CORS (`OLLAMA_ORIGINS` set to the dev and Pages origins)
- [ ] Call 2 prompt + schema; try it on 5 realistic brain-dumps, tune the prompt
- [ ] Call 1 prompt + schema for availability
- [ ] UI: text box + slider, Today view, full plan view, Done/Skip, localStorage
- [ ] Hand the rough version to the friend

**Day 2: polish, stretch, write**

- [ ] Fix whatever the friend hit first
- [ ] Re-plan on load after missed slots
- [ ] Stretch: .ics upload, then WebLLM adapter, only if time allows
- [ ] README: setup (install Ollama, pull model, set `OLLAMA_ORIGINS`), screenshots
- [ ] Write and publish the DEV post (fixed time block, not leftover time)

**Manual test cases for the prompts:** a single huge vague goal ("get my life together"), three goals with different deadlines, availability phrased loosely ("weekday evenings, not Wednesday"), a goal already broken down by the user, Hinglish or mixed-language input.

## Write-up notes for the DEV post

The post should open with the friend's specific experience of overwhelm and close with what he said after using it; the tech sits in between.

- **Opening:** a concrete moment you have seen (what he does when a big task lands). Get his permission for anything personal; he can stay anonymous.
- **Design follows the person:** the per-plan slider ("a bad day gets 15-minute tasks"), the tiny first step, the Today-only view, no overdue pile.
- **Why open matters:** inference on his own machine, so goals and calendar never go to an AI provider; free to run; model swappable via the adapter. State honestly what still touches the network (model download, library CDN).
- **Technical point worth making:** the model handles the fuzzy part, code handles the exact part, and code enforces the size cap the prompt asks for.
- **Research, used carefully:** implementation intentions (Gollwitzer and Sheeran, 2006 meta-analysis) supports "concrete step at a set time". Treat the Zeigarnik effect as weak evidence; the Ovsiankina effect (resuming interrupted tasks) held up better in recent work. Call the two-minute rule practitioner advice, not research. Verify every citation against the source before publishing.
- **Limits section:** what it does not do, what was not tested, small-model failure modes seen.
- **Friend's feedback:** a direct quote and one thing you changed because of it.

## Open questions and first instructions

**Open questions**

- [ ] Friend's laptop: does it have a GPU or at least 16 GB RAM? Yes means Ollama with a 7-8B model; no means plan for WebLLM with a smaller model sooner.
- [ ] Which current Ollama model gives the best decomposition at 7-8B? Test two side by side on the manual test cases.
- [ ] Challenge submission deadline (check the challenge page).
- [ ] React or plain JS for the UI.

**First prompt for Claude Code**

> Read HANDOFF.md. Scaffold a Vite app with Vitest. Implement `src/scheduler.js` exactly as specified in "Scheduler and validation", as a pure function, with the full unit test list. Do not touch the model or UI yet. Then implement `src/validate.js` with tests. Stop and show me the test results.

Tip: export this doc as Markdown and save it in the repo as `HANDOFF.md` (or `CLAUDE.md` so Claude Code loads it automatically).
