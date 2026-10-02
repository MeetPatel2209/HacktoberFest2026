import { describe, it, expect, vi } from 'vitest';
import { createOllamaAdapter, LLMError } from '../src/llm/adapter.js';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const chatReply = (content) => jsonResponse({ message: { role: 'assistant', content }, done: true });

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const messages = [{ role: 'user', content: 'hi' }];

describe('ollama adapter: complete', () => {
  it('posts a non-streaming chat request with the schema as format', async () => {
    const fetch = vi.fn().mockResolvedValue(chatReply('{"ok":true}'));
    const llm = createOllamaAdapter({ fetch, model: 'test-model' });

    await expect(llm.complete(messages, schema)).resolves.toEqual({ ok: true });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      model: 'test-model',
      messages,
      stream: false,
      format: schema,
      options: { temperature: 0, num_ctx: 8192, num_predict: 3000 },
    });
  });

  it('uses qwen3:8b with thinking off by default', async () => {
    const fetch = vi.fn(async () => chatReply('{}'));
    const llm = createOllamaAdapter({ fetch });
    await llm.complete(messages, schema);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.model).toBe('qwen3:8b');
    expect(body.think).toBe(false);
    expect(llm.think).toBe(false);
  });

  it('sends think only for models that have a default or when set explicitly', async () => {
    const fetch = vi.fn(async () => chatReply('{}'));
    await createOllamaAdapter({ fetch, model: 'llama3.1:8b' }).complete(messages, schema);
    await createOllamaAdapter({ fetch, model: 'llama3.1:8b', think: false }).complete(messages, schema);
    await createOllamaAdapter({ fetch, model: 'qwen3:14b', think: true }).complete(messages, schema);
    const sent = fetch.mock.calls.map(([, init]) => JSON.parse(init.body).think);
    expect(sent).toEqual([undefined, false, true]);
  });

  it('uses a custom base URL', async () => {
    const fetch = vi.fn().mockResolvedValue(chatReply('{}'));
    await createOllamaAdapter({ fetch, baseUrl: 'http://127.0.0.1:9999' }).complete(messages, schema);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/chat');
  });

  it('reports unreachable when fetch fails (Ollama down or CORS blocked)', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await createOllamaAdapter({ fetch }).complete(messages, schema).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe('unreachable');
  });

  it('reports a missing model from a 404', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "model 'nope' not found" }, 404));
    const err = await createOllamaAdapter({ fetch }).complete(messages, schema).catch((e) => e);
    expect(err.kind).toBe('model-missing');
    expect(err.message).toMatch(/not found/);
  });

  it('reports other HTTP errors with the server message', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'out of memory' }, 500));
    const err = await createOllamaAdapter({ fetch }).complete(messages, schema).catch((e) => e);
    expect(err.kind).toBe('http');
    expect(err.message).toBe('out of memory');
  });

  it('reports bad output when the content is not JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(chatReply('Sure! Here is your plan:'));
    const err = await createOllamaAdapter({ fetch }).complete(messages, schema).catch((e) => e);
    expect(err.kind).toBe('bad-output');
  });

  it('reports a cut-off answer (hit the token cap) as bad output', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ message: { content: '{"goals":[{"id":"g1"' }, done: true, done_reason: 'length' }));
    const err = await createOllamaAdapter({ fetch, maxTokens: 50 }).complete(messages, schema).catch((e) => e);
    expect(err.kind).toBe('bad-output');
    expect(err.message).toMatch(/cut off after 50 tokens/);
  });

  it('reports bad output when there is no message content', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ done: true }));
    const err = await createOllamaAdapter({ fetch }).complete(messages, schema).catch((e) => e);
    expect(err.kind).toBe('bad-output');
  });

  it('times out a request that never answers', async () => {
    const fetch = vi.fn(
      (_url, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        ),
    );
    const err = await createOllamaAdapter({ fetch, timeoutMs: 10 }).complete(messages, schema).catch((e) => e);
    expect(err.kind).toBe('timeout');
  });
});

describe('ollama adapter: status', () => {
  it('reports reachable and whether the model is pulled', async () => {
    const fetch = vi.fn(async () => jsonResponse({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen:latest' }] }));
    expect(await createOllamaAdapter({ fetch, model: 'llama3.1:8b' }).status()).toEqual({
      reachable: true,
      modelReady: true,
      models: ['llama3.1:8b', 'qwen:latest'],
    });
    expect((await createOllamaAdapter({ fetch, model: 'qwen' }).status()).modelReady).toBe(true);
    expect((await createOllamaAdapter({ fetch, model: 'mistral' }).status()).modelReady).toBe(false);
  });

  it('reports unreachable instead of throwing', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await createOllamaAdapter({ fetch }).status()).toEqual({ reachable: false, modelReady: false, models: [] });
  });
});
