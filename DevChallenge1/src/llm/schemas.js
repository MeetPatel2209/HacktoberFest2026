// JSON schemas passed to Ollama's `format` (constrained decoding).
// Simple subset only: no numeric bounds, patterns or $ref; validate.js enforces the exact rules.
// Property order is deliberate: it is the order the model generates fields in.

// Call 2: decompose goals. Goals first so goalIds point at goals that already exist;
// isFirstStep before title so the model commits to "tiny" before writing it;
// title before minutes so the estimate follows the action; dependsOn last, pointing back.
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    goals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          deadline: { type: ['string', 'null'] },
        },
        required: ['id', 'title', 'deadline'],
        additionalProperties: false,
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          goalId: { type: 'string' },
          isFirstStep: { type: 'boolean' },
          title: { type: 'string' },
          minutes: { type: 'integer' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'goalId', 'isFirstStep', 'title', 'minutes', 'dependsOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['goals', 'tasks'],
  additionalProperties: false,
};

const STEP = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    minutes: { type: 'integer' },
  },
  required: ['title', 'minutes'],
  additionalProperties: false,
};

// Follow-up A: split one oversized task.
export const SPLIT_SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: STEP } },
  required: ['steps'],
  additionalProperties: false,
};

// Follow-up B: one tiny first step.
export const FIRST_STEP_SCHEMA = STEP;

// Follow-up C: rewrite non-English titles in English.
export const ENGLISH_SCHEMA = {
  type: 'object',
  properties: {
    titles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['id', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['titles'],
  additionalProperties: false,
};
