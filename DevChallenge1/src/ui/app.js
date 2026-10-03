// The whole UI: input -> planning -> Today / Full plan. Plain DOM, re-rendered on every change.
// All model text is inserted as text nodes (never innerHTML).

import { createPlan, markDone, undoDone, skipTask, refreshOnLoad, todayItems, nextItem, scheduleByDay, localDate } from '../planner.js';
import { loadState, saveState, loadDraft, saveDraft } from '../storage.js';
import { LLMError } from '../llm/adapter.js';
import { PlanError } from '../validate.js';

const EXAMPLE =
  "Finish thesis chapter 3 by Friday (intro + 3 sections), update my resume and email it to Priya by Monday. I'm free after 7 on weekdays and Saturday morning.";

export function mountApp(root, { llm, storage = globalThis.localStorage, now = () => new Date() }) {
  const draft = loadDraft(storage);
  let state = loadState(storage);
  if (state) {
    state = refreshOnLoad(state, now());
    saveState(state, storage);
  }
  const ui = {
    view: state ? 'today' : 'input',
    text: draft?.text ?? '',
    maxMinutes: draft?.maxMinutes ?? 25,
    error: null,
    toast: '',
  };

  function update(changes) {
    Object.assign(ui, changes);
    render();
  }

  function commit(next, changes = {}) {
    state = next;
    saveState(state, storage);
    update(changes);
  }

  async function submit() {
    const text = ui.text.trim();
    if (!text) {
      update({ error: { title: 'Write a few things down first.', body: 'Goals, deadlines and when you are free, in your own words.' } });
      return;
    }
    saveDraft({ text: ui.text, maxMinutes: ui.maxMinutes }, storage);
    update({ view: 'loading', error: null });
    try {
      const plan = await createPlan(llm, { text, maxMinutes: ui.maxMinutes }, now());
      commit(plan, { view: 'today', toast: '' });
    } catch (err) {
      update({ view: 'input', error: describeError(err, llm.model) });
    }
  }

  function render() {
    const t = now();
    root.replaceChildren(
      el('div', { class: 'app' },
        header(),
        el('main', {},
          ui.view === 'input' && inputView(),
          ui.view === 'loading' && loadingView(),
          ui.view === 'today' && state && todayView(t),
          ui.view === 'plan' && state && planView(t),
        ),
        el('p', { class: 'foot' }, `Runs on ${llm.model} on your own computer. Nothing you type leaves it.`),
      ),
    );
    if (ui.view === 'input') root.querySelector('.dump')?.focus({ preventScroll: true });
  }

  function header() {
    const showNav = state && (ui.view === 'today' || ui.view === 'plan');
    return el('header', { class: 'header' },
      el('h1', { class: 'brand' }, 'Goal-to-Plan', el('span', {}, 'one small step')),
      showNav &&
        el('nav', { class: 'nav', 'aria-label': 'Views' },
          tab('Today', 'today'),
          tab('Full plan', 'plan'),
          el('button', { class: 'btn btn-outline', onclick: () => update({ view: 'input', error: null, toast: '' }) }, 'New plan'),
        ),
    );
  }

  function tab(label, view) {
    return el('button', { class: 'tab', 'aria-current': ui.view === view ? 'page' : null, onclick: () => update({ view, toast: '' }) }, label);
  }

  // ---------- input ----------

  function inputView() {
    const sizeOut = el('span', { class: 'size-value', id: 'size-value' }, `${ui.maxMinutes} min`);
    return el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
      el('label', { class: 'field-label', for: 'dump' }, "What's on your plate?"),
      el('textarea', {
        id: 'dump',
        class: 'dump',
        placeholder: EXAMPLE,
        oninput: (e) => { ui.text = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); },
      }, ui.text),
      el('p', { class: 'hint' },
        el('strong', {}, 'Small model, big heart. '),
        'This runs on a small AI on your own laptop, not a giant cloud one, so it plans best when you say what the work actually is. ',
        el('em', {}, '"Write 3 sections of my thesis chapter by Friday"'),
        ' works far better than ',
        el('em', {}, '"get my life together"'),
        '.',
      ),
      el('div', { class: 'size' },
        el('div', { class: 'size-row' },
          el('label', { class: 'field-label', for: 'size' }, 'Task size'),
          sizeOut,
        ),
        el('input', {
          id: 'size',
          class: 'slider',
          type: 'range',
          min: 10,
          max: 60,
          step: 5,
          value: ui.maxMinutes,
          'aria-describedby': 'size-help',
          oninput: (e) => { ui.maxMinutes = Number(e.target.value); sizeOut.textContent = `${ui.maxMinutes} min`; },
        }),
        el('div', { class: 'size-scale', id: 'size-help' }, el('span', {}, '10 min'), el('span', {}, 'Tough day? Go smaller.'), el('span', {}, '60 min')),
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', type: 'submit' }, 'Make my plan'),
        el('span', { class: 'kbd' }, 'or Ctrl + Enter'),
        state && el('button', { class: 'link', type: 'button', onclick: () => update({ view: 'today', error: null }) }, 'Back to my plan'),
      ),
      ui.error && errorBox(ui.error),
    );
  }

  function loadingView() {
    return el('div', { role: 'status', 'aria-live': 'polite' },
      el('div', { class: 'note loading' },
        el('h2', { class: 'note-title' }, 'Breaking it into small steps'),
        el('p', { class: 'note-empty' }, 'Usually 15 to 40 seconds on your laptop.'),
      ),
    );
  }

  function errorBox(error) {
    return el('div', { class: 'error', role: 'alert' },
      el('p', {}, el('strong', {}, error.title)),
      error.body && el('p', {}, error.body),
      error.code && el('code', {}, error.code),
    );
  }

  // ---------- today ----------

  function todayView(t) {
    const items = todayItems(state, t);
    const next = nextItem(state, t);
    const doneCount = items.filter((p) => isDone(p.taskId)).length;
    let body;
    if (items.length === 0) {
      body = [
        el('p', { class: 'note-empty' }, 'Nothing planned for today.'),
        next && el('p', { class: 'note-foot' }, `Next up: ${dayLabel(next.start)}, ${time(next.start)}: ${taskOf(next.taskId).title}`),
      ];
    } else {
      body = [
        el('ul', { class: 'points' }, items.map((p) => point(p, { next: next?.taskId === p.taskId, actions: true }))),
        el('p', { class: 'note-foot' },
          doneCount === items.length ? 'All done for today. Nice work.' : `${doneCount} of ${items.length} done today`),
      ];
    }
    return el('section', { 'aria-label': 'Today' },
      el('div', { class: 'note' },
        el('h2', { class: 'note-title' }, 'Today'),
        el('p', { class: 'note-sub' }, dayLabel(localDate(t))),
        body,
      ),
      el('div', { class: 'below-note' },
        el('span', { class: 'toast', role: 'status', 'aria-live': 'polite' }, ui.toast),
        el('button', { class: 'link', onclick: () => update({ view: 'plan', toast: '' }) }, 'See the full plan →'),
      ),
    );
  }

  function point(p, { next = false, actions = false } = {}) {
    const task = taskOf(p.taskId);
    const done = isDone(p.taskId);
    const goal = state.goals.find((g) => g.id === task.goalId);
    return el('li', { class: `point${done ? ' done' : ''}${next && !done ? ' next' : ''}` },
      el('span', { class: 'point-title' }, task.title, next && !done && el('span', { class: 'next-tag' }, 'next')),
      el('span', { class: 'point-meta' }, `${time(p.start)} to ${time(p.end)}${goal ? ` · ${goal.title}` : ''}`),
      // Buttons only where a decision is due: the next task (Done / Skip) and done tasks (Undo).
      actions && (done || next) &&
        el('span', { class: 'point-actions' },
          done
            ? el('button', { class: 'mini', onclick: () => commit(undoDone(state, p.taskId)), 'aria-label': `Undo done: ${task.title}` }, 'Undo')
            : [
                el('button', { class: 'mini solid', onclick: () => commit(markDone(state, p.taskId)), 'aria-label': `Done: ${task.title}` }, 'Done'),
                el('button', {
                  class: 'mini',
                  onclick: () => commit(skipTask(state, p.taskId, now()), { toast: 'Moved it to later. No problem.' }),
                  'aria-label': `Skip for now: ${task.title}`,
                }, 'Skip'),
              ],
        ),
    );
  }

  // ---------- full plan ----------

  function planView(t) {
    const today = localDate(t);
    const days = scheduleByDay(state);
    const notes = days.map(({ date, items }, i) =>
      el('div', { class: `note${i % 2 ? ' tilt-right' : ''}` },
        el('h2', { class: 'note-title' }, dayLabel(date), date === today && el('span', { class: 'today-tag' }, '(today)')),
        el('ul', { class: 'points' }, items.map((p) => point(p))),
      ),
    );
    if (state.unscheduled.length > 0) {
      notes.push(
        el('div', { class: `note grey${days.length % 2 ? ' tilt-right' : ''}` },
          el('h2', { class: 'note-title' }, "Didn't fit this week"),
          el('p', { class: 'note-sub' }, 'Not enough free time before the deadline. Worth a chat, not a cram.'),
          el('ul', { class: 'points' },
            state.unscheduled.map((id) => {
              const task = taskOf(id);
              const goal = state.goals.find((g) => g.id === task?.goalId);
              return el('li', { class: 'point' },
                el('span', { class: 'point-title' }, task?.title ?? id),
                goal && el('span', { class: 'point-meta' }, goal.title),
              );
            }),
          ),
        ),
      );
    }
    const deadlines = state.goals.filter((g) => g.deadline);
    return el('section', { 'aria-label': 'Full plan' },
      notes.length ? el('div', { class: 'board' }, notes) : el('div', { class: 'note' }, el('p', { class: 'note-empty' }, 'Everything is done.')),
      el('div', { class: 'reading' },
        el('h2', {}, 'How I read your free time'),
        el('ul', {}, state.availability.assumptions.length ? state.availability.assumptions.map((a) => el('li', {}, a)) : el('li', {}, 'Exactly as you wrote it.')),
        deadlines.length > 0 && el('h2', {}, 'Deadlines'),
        deadlines.length > 0 && el('ul', {}, deadlines.map((g) => el('li', {}, `${g.title}: ${dayLabel(g.deadline)}`))),
        el('p', {}, 'Something misread? Change the text and make a new plan.'),
      ),
    );
  }

  // ---------- helpers ----------

  function taskOf(id) {
    return state.tasks.find((x) => x.id === id);
  }

  function isDone(id) {
    return state.status[id] === 'done';
  }

  // Keep "next" and Today current while the tab stays open; re-plan if the person comes back
  // after a missed slot.
  setInterval(() => { if (ui.view === 'today' || ui.view === 'plan') render(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state || ui.view === 'loading') return;
    const fresh = refreshOnLoad(state, now());
    if (fresh !== state) commit(fresh);
    else if (ui.view !== 'input') render();
  });

  render();
}

export function describeError(err, model) {
  if (err instanceof LLMError) {
    if (err.kind === 'unreachable') {
      return {
        title: "Can't reach the model on this computer.",
        body: 'Make sure Ollama is running. If you are using the website version, Ollama also has to allow this site (OLLAMA_ORIGINS, see the README).',
        code: 'systemctl status ollama',
      };
    }
    if (err.kind === 'model-missing') return { title: "The model isn't downloaded yet.", body: 'Run this once in a terminal:', code: `ollama pull ${model}` };
    if (err.kind === 'timeout') return { title: 'The model took too long.', body: 'Try again, or split the brain-dump into two smaller plans.' };
    if (err.kind === 'http') return { title: 'Ollama returned an error.', body: err.message };
    return { title: 'The model gave an answer I could not use.', body: 'Try again; rewording a little often helps.' };
  }
  if (err instanceof PlanError) return { title: err.message };
  return { title: 'Something went wrong.', body: String(err?.message ?? err) };
}

function time(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(dateOrIso) {
  const [y, m, d] = dateOrIso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}
