// Model adapter. The only code that talks to a model.
//
// complete(messages, schema) -> Promise<object>
//   messages: [{ role: "system" | "user" | "assistant", content }]
//   schema:   JSON schema, passed to Ollama's `format` so output is constrained to it
//
// Ollama now; a WebLLM implementation can later return the same { complete } shape.

export const OLLAMA_URL = 'http://localhost:11434';
// Comparing llama3.1:8b vs qwen3:8b (think: false) on the manual test cases; winner becomes the default.
export const DEFAULT_MODEL = 'llama3.1:8b';
export const DEFAULT_TIMEOUT_MS = 120_000; // generous; on the friend's RTX 4060 a call should take seconds
// Context window (prompt + answer). Ollama's default 4096 is too tight for a 3-goal plan.
export const DEFAULT_NUM_CTX = 8192;
// Cap on answer length. Real plans are ~1000 tokens; a model stuck repeating itself is cut off here.
export const DEFAULT_MAX_TOKENS = 3000;

export class LLMError extends Error {
  // kind: "unreachable" | "model-missing" | "timeout" | "http" | "bad-output"
  constructor(kind, message, cause) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.cause = cause;
  }
}

export function createOllamaAdapter({
  baseUrl = OLLAMA_URL,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  numCtx = DEFAULT_NUM_CTX,
  maxTokens = DEFAULT_MAX_TOKENS,
  // true/false for thinking models (qwen3: pass false); leave undefined for models without it.
  think,
  fetch = globalThis.fetch,
} = {}) {
  async function complete(messages, schema) {
    const body = {
      model,
      messages,
      stream: false,
      format: schema,
      options: { temperature: 0, num_ctx: numCtx, num_predict: maxTokens },
    };
    if (think !== undefined) body.think = think;
    const data = await request(fetch, `${baseUrl}/api/chat`, timeoutMs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (data?.done_reason === 'length') {
      throw new LLMError('bad-output', `Answer was cut off after ${maxTokens} tokens; the model was probably repeating itself`);
    }
    const content = data?.message?.content;
    if (typeof content !== 'string') {
      throw new LLMError('bad-output', 'Ollama response had no message content');
    }
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new LLMError('bad-output', `Model output was not valid JSON: ${err.message}`, err);
    }
  }

  // Is Ollama reachable from this page, and is the model pulled?
  // Network failure here usually means Ollama isn't running or OLLAMA_ORIGINS
  // doesn't include this page's origin; the browser can't tell us which.
  async function status() {
    try {
      const data = await request(fetch, `${baseUrl}/api/tags`, 5_000, { method: 'GET' });
      const names = (data?.models ?? []).map((m) => m.name);
      return { reachable: true, modelReady: names.some((n) => sameModel(n, model)), models: names };
    } catch (err) {
      if (err instanceof LLMError && err.kind !== 'http') return { reachable: false, modelReady: false, models: [] };
      throw err;
    }
  }

  return { complete, status, model };
}

async function request(fetch, url, timeoutMs, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new LLMError('timeout', `No response from the model after ${Math.round(timeoutMs / 1000)}s`, err);
    }
    throw new LLMError('unreachable', `Can't reach Ollama at ${new URL(url).origin}`, err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = parseError(detail) ?? `HTTP ${res.status}`;
    const kind = res.status === 404 && /model/i.test(message) ? 'model-missing' : 'http';
    throw new LLMError(kind, message);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new LLMError('bad-output', 'Ollama returned a non-JSON response', err);
  }
}

function parseError(text) {
  try {
    return JSON.parse(text).error ?? null;
  } catch {
    return text || null;
  }
}

// "llama3.1:8b" matches "llama3.1:8b"; "llama3.1" matches "llama3.1:latest".
function sameModel(installed, wanted) {
  const withTag = (n) => (n.includes(':') ? n : `${n}:latest`);
  return withTag(installed) === withTag(wanted);
}
