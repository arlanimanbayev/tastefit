// Shared test helpers: demo-mode Qloo client and a scriptable fake Gemini endpoint.
import { createQlooClient } from '../lib/qloo.js';
import { createMockFetch, MOCK_API_KEY } from '../lib/mock-qloo.js';
import { createGemini } from '../lib/llm.js';

// Tests never touch real services.
delete process.env.QLOO_API_KEY;
delete process.env.GEMINI_API_KEY;
process.env.MOCK_LATENCY_MS = '0';
process.env.RATE_LIMIT = 'off';

export function mockQloo() {
  return createQlooClient({ apiKey: MOCK_API_KEY, baseUrl: 'https://demo.qloo.invalid', fetchImpl: createMockFetch(), mode: 'mock', cache: null });
}

export const SAMPLE_INPUT = {
  city: 'Chicago',
  occasion: 'night_out',
  budget: 2,
  people: [
    { name: 'Ana', favorites: [{ text: 'Phoebe Bridgers', kind: 'music' }, { text: 'Lady Bird', kind: 'film' }, { text: 'Ramen', kind: 'food' }, { text: 'Normal People', kind: 'book' }] },
    { name: 'Ben', favorites: [{ text: 'Korean food', kind: 'food' }, { text: 'Parasite', kind: 'film' }, { text: 'NewJeans', kind: 'music' }] },
    { name: 'Cleo', favorites: [{ text: 'Daft Punk', kind: 'music' }, { text: 'Blade Runner 2049', kind: 'film' }, { text: 'Tacos', kind: 'food' }] },
  ],
};

/**
 * Fake Gemini generateContent endpoint. `script(turn, body)` returns
 * { parts } for a model turn, { status, message } for an HTTP error, or an Error to throw.
 */
export function fakeGemini(script, model = 'test-model') {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const out = script(requests.length - 1, body);
    if (out instanceof Error) throw out;
    if (out.status) return new Response(JSON.stringify({ error: { message: out.message } }), { status: out.status });
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: out.parts }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } }), { status: 200 });
  };
  return { requests, llm: createGemini({ apiKey: 'gemini-test-key', model, fetchImpl }) };
}

/** The last function response the agent sent back to Gemini, by tool name. */
export function lastToolResult(body, name) {
  const turn = body.contents[body.contents.length - 1];
  return turn.parts.find((p) => p.functionResponse?.name === name)?.functionResponse.response.result;
}
