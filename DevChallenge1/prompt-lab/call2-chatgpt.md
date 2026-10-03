# Call 2 design: ChatGPT's answer

> ChatGPT's raw response to [`call2-meta-prompt.md`](call2-meta-prompt.md), kept unedited for comparison. Section 8 is missing because the test inputs were cut off when the brief was pasted. This design was **not** used: the project went with [`call2-claude.md`](call2-claude.md), later revised (see the status note there). One difference: this version mirrors the user's language, while the app always writes tasks in English.

## 1. CALL 2 SYSTEM PROMPT

```text
You decompose a person's goals into small, concrete tasks.

Your job:
- Read the brain-dump and extract only goals the person actually mentioned.
- Split each goal into actionable tasks.
- Read explicit deadlines and resolve relative dates using today and weekday.
- Do NOT use or infer availability. Do NOT schedule anything.
- Respect maxMinutes for each task.
- Each goal must have exactly one first step: <=10 minutes, no dependencies, and a tiny physical action that makes starting easier.
- Task titles must be concrete actions starting with a verb: "open", "write", "email", "list", "print", etc.
- Never use vague actions such as "work on", "research", "think about", "prepare", or "finalize".
- Each title must make sense by itself on a Today screen.
- Add dependsOn only when the task genuinely requires another task to be finished. Do not chain independent work.
- Keep tasks in sensible working order within each goal.
- If the person already gave steps, keep those steps unless they are too large; split only those that need splitting.
- Do not invent goals or deadlines.
- If no deadline is stated, use null.
- Use the person's language. For mixed language, mirror the mixed style.
- IDs must be unique: goals g1, g2, ... and tasks t1, t2, ...
- Return JSON only. No explanation, markdown, or extra fields.

Deadline conventions:
- Resolve "by Friday", "tomorrow", etc. from today.
- For a named period such as "next week", use the end of that period.
- "end of month" means the last calendar day of that month.
- If the wording is genuinely too ambiguous to resolve to one date, use null.

Example:
Input: "fix my resume, start by opening the PDF and add my Oracle job"
Good task titles:
"Open the resume PDF"
"Add the Oracle job to the experience section"
"Rewrite the Oracle job bullets"
Bad task titles:
"Work on resume"
"Improve experience section"
"Finalize resume"
```

## 2. CALL 2 USER MESSAGE TEMPLATE

```text
Today is {today}, {weekday}.
Maximum task size: {maxMinutes} minutes.

Brain-dump:
{brainDump}

Extract the goals and decompose them into small tasks.

Return exactly this JSON structure:
{
  "goals": [
    {
      "id": "g1",
      "title": "...",
      "deadline": "YYYY-MM-DD"
    }
  ],
  "tasks": [
    {
      "id": "t1",
      "goalId": "g1",
      "title": "...",
      "minutes": 5,
      "dependsOn": [],
      "isFirstStep": true
    }
  ]
}
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
          "id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "deadline": {
            "type": ["string", "null"]
          }
        },
        "required": ["id", "title", "deadline"]
      }
    },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "goalId": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "minutes": {
            "type": "integer"
          },
          "dependsOn": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "isFirstStep": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "goalId",
          "title",
          "minutes",
          "dependsOn",
          "isFirstStep"
        ]
      }
    }
  },
  "required": ["goals", "tasks"]
}
```

## 4. FOLLOW-UP A: SPLIT TASK

### System prompt

```text
You split one oversized task into small, concrete steps.

Rules:
- Preserve the original task's intent.
- Return steps in working order.
- Every step must be <= maxMinutes.
- Steps must be concrete physical actions starting with a verb.
- Never use vague actions such as "work on", "research", "think about", "prepare", or "finalize".
- Each step must make sense by itself.
- Do not add unrelated work.
- Do not schedule anything.
- Use the same language as the input.
- Return JSON only. No explanation or extra fields.

Example:
Task: "Rewrite my resume" (50 minutes)
maxMinutes: 25

Good:
{
  "steps": [
    {"title": "Open the resume and mark the sections to change", "minutes": 10},
    {"title": "Rewrite the experience section", "minutes": 20},
    {"title": "Rewrite the skills section", "minutes": 15}
  ]
}
```

### User template

```text
Goal: {goalTitle}
Task: {title}
Current minutes: {minutes}
Maximum minutes per step: {maxMinutes}

Split this task into small concrete steps.
```

### Schema

```json
{
  "type": "object",
  "properties": {
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string"
          },
          "minutes": {
            "type": "integer"
          }
        },
        "required": ["title", "minutes"]
      }
    }
  },
  "required": ["steps"]
}
```

## 5. FOLLOW-UP B: SMALLER FIRST STEP

### System prompt

```text
You create one tiny starting action for an overwhelming task.

Rules:
- Return exactly one action.
- The action must take <=10 minutes.
- It must be a concrete physical action starting with a verb.
- It must reduce the barrier to starting the goal.
- It must not try to complete the whole task.
- Never use "work on", "research", "think about", "prepare", or "finalize".
- Use the same language as the input.
- Return JSON only. No explanation or extra fields.

Good examples:
"Open the thesis document"
"Write the first sentence"
"Put the resume PDF on the desktop"
"List the three sections to change"

Bad examples:
"Work on the thesis"
"Improve the resume"
"Research the topic"
```

### User template

```text
Goal: {goalTitle}
Current first step: {title}
Current minutes: {minutes}

Make this into one tiny starting action that takes no more than 10 minutes.
```

### Schema

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string"
    },
    "minutes": {
      "type": "integer"
    }
  },
  "required": ["title", "minutes"]
}
```

## 6. DESIGN NOTES

* **Optimize for 7–8B:** short rules, repeated concrete examples, and little abstract reasoning. Smaller models tend to follow examples more reliably than long policy-like instructions.
* **Few-shot example:** yes, but only one. It demonstrates the most important distinction: concrete action vs. vague task.
* **No availability:** explicitly saying this call ignores availability prevents the model from trying to solve scheduling itself.
* **Deadline handling:** the prompt gives simple conventions rather than asking the model to reason about arbitrary calendar semantics.
* **First step:** the definition emphasizes a *physical starting action*, because "research thesis topic" can technically be small but still leaves the user deciding what to do.
* **Dependencies:** explicitly discourage chaining. A small model may otherwise produce `t1 → t2 → t3 → t4` because it interprets "working order" as dependency order.
* **Existing steps:** preserving user-provided decomposition prevents the model from unnecessarily rewriting a plan that is already useful.
* **Property order:** `goals` comes before `tasks` because tasks reference goal IDs. Within a goal: `id → title → deadline`. Within a task: `id → goalId → title → minutes → dependsOn → isFirstStep`. This gives the model identifiers before it has to emit references.
* **Schema is deliberately weak:** no `minimum`, `maximum`, regex, `additionalProperties`, `$ref`, `oneOf`, etc. The application already performs the exact validation and repair.
* **Follow-ups are narrower:** they don't repeat the entire Call 2 instruction set, reducing context and giving the small model one very specific transformation.

## 7. EXPECTED FAILURE MODES

A 7–8B model will still likely make some of these mistakes:

* **Vague titles:** `"Work on thesis"` or `"Improve resume"` despite the explicit rule.
* **Fake concreteness:** `"Research relevant papers"` is grammatical but still leaves the user deciding what to research.
* **Over-chaining:** making every task depend on the previous one.
* **Bad first steps:** `"Plan the thesis chapter"` instead of something immediately executable like `"Open the thesis document"`.
* **Too many micro-tasks:** splitting a naturally 15-minute action into several 5-minute actions.
* **Too few tasks:** producing one 25-minute task that is still cognitively large.
* **Deadline hallucination:** assigning a deadline to a goal merely because another goal has one.
* **Relative-date mistakes:** especially around `"next Friday"`, `"this weekend"`, and `"next week"`.
* **Goal invention:** turning implicit assumptions into new goals. For example, `"finish thesis"` should not automatically create `"proofread thesis"` unless proofreading was mentioned or clearly required by the stated task.
* **Language drift:** translating Hinglish into English instead of mirroring the user's language.
* **Dependency errors:** referencing a task from another goal or creating references to tasks that don't exist. Your post-processing already handles this safely.

For testing, I would especially measure **first-step quality**, **title standalone quality**, **unnecessary dependency rate**, and **deadline extraction accuracy** rather than merely checking whether the JSON parses.

## 8. SAMPLE OUTPUTS

I don't see the **5 test inputs** in the message—the prompt says they are "below", but no five inputs are actually included. I don't want to invent test cases and present them as your requested results.

With the supplied context (`today = 2026-10-02`, Friday, `maxMinutes = 25`), the expected outputs can be generated exactly once those five brain-dumps are provided.
