// localStorage load/save under one versioned key. Never throws: a private window or full
// storage just means the plan isn't remembered.

export const STORAGE_KEY = 'planner:v1';

export function loadState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state?.version === 1 && Array.isArray(state.tasks) && Array.isArray(state.schedule) ? state : null;
  } catch {
    return null;
  }
}

export function saveState(state, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearState(storage = globalThis.localStorage) {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}

// Remember the last brain-dump separately, so "New plan" starts from it.
export const DRAFT_KEY = 'planner:v1:draft';

export function loadDraft(storage = globalThis.localStorage) {
  try {
    const d = JSON.parse(storage?.getItem(DRAFT_KEY) ?? 'null');
    return d && typeof d.text === 'string' ? d : null;
  } catch {
    return null;
  }
}

export function saveDraft(draft, storage = globalThis.localStorage) {
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // not remembered
  }
}
