// Call 2 end to end: prompt -> model -> validated { goals, tasks }.
//
// decompose(llm, { brainDump, maxMinutes, today }) -> Promise<{ goals, tasks }>
//   llm:   an adapter with complete(messages, schema), e.g. createOllamaAdapter()
//   today: local date "YYYY-MM-DD"
//
// Throws LLMError when the model can't be reached (so the UI can say "start Ollama"),
// PlanError when it answered but twice failed the schema.

import { LLMError } from './adapter.js';
import { planMessages, splitMessages, firstStepMessages, englishMessages } from './prompts.js';
import { PLAN_SCHEMA, SPLIT_SCHEMA, FIRST_STEP_SCHEMA, ENGLISH_SCHEMA } from './schemas.js';
import { validatePlan } from '../validate.js';

export async function decompose(llm, { brainDump, maxMinutes, today }) {
  const requestPlan = async (feedback) => {
    try {
      return await llm.complete(planMessages({ brainDump, maxMinutes, today }, feedback), PLAN_SCHEMA);
    } catch (err) {
      // Unparseable output counts as an invalid answer, so validate retries with feedback.
      if (err instanceof LLMError && err.kind === 'bad-output') return err.message;
      throw err;
    }
  };

  return validatePlan(requestPlan, {
    maxMinutes,
    brainDump,
    splitTask: async (task, max, goal) => (await llm.complete(splitMessages(task, max, goal), SPLIT_SCHEMA)).steps,
    shrinkFirstStep: (task, _max, goal) => llm.complete(firstStepMessages(task, goal), FIRST_STEP_SCHEMA),
    toEnglish: async (items) => (await llm.complete(englishMessages(items), ENGLISH_SCHEMA)).titles,
  });
}
