/**
 * Minimal Google Gemini client for an agent tool-calling loop.
 *
 * REST: POST {base}/models/{model}:generateContent with header x-goog-api-key.
 * Request:  { systemInstruction, contents, tools:[{functionDeclarations}], toolConfig }
 * Response: candidates[0].content.parts[] containing text and/or functionCall parts.
 *
 * Gemini 3 models attach a `thoughtSignature` to function-call parts that must be
 * sent back on the next turn. We append the model's `content` to the history
 * *verbatim*, so signatures (and any other metadata) round-trip untouched.
 * Function results go back as a `user` turn of `functionResponse` parts.
 */

export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class LlmError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

export function createGemini({ apiKey, model = GEMINI_DEFAULT_MODEL, baseUrl = GEMINI_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new LlmError('GEMINI_API_KEY is required.');
  if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(model)) throw new LlmError('GEMINI_MODEL has an invalid format.');
  const url = `${baseUrl.replace(/\/+$/, '')}/models/${model}:generateContent`;

  return {
    provider: 'gemini',
    model,
    /**
     * One model turn. Returns { content, functionCalls, text, usage }.
     * `content` is the raw model Content object to push onto the history.
     */
    async generate({ system, contents, functionDeclarations = [], mode = 'AUTO', timeoutMs = 12000, maxOutputTokens = 4096 }) {
      const body = {
        contents,
        generationConfig: { maxOutputTokens },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (functionDeclarations.length) {
        body.tools = [{ functionDeclarations }];
        body.toolConfig = { functionCallingConfig: { mode } };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
      let res;
      let data;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        throw new LlmError(err?.name === 'AbortError' ? 'Gemini timed out.' : 'Could not reach Gemini.');
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new LlmError(data?.error?.message || `Gemini request failed (HTTP ${res.status}).`, { status: res.status });
      const candidate = data?.candidates?.[0];
      const content = candidate?.content || { role: 'model', parts: [] };
      if (!content.role) content.role = 'model';
      const parts = Array.isArray(content.parts) ? content.parts : [];
      return {
        content,
        functionCalls: parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {} })),
        text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim(),
        finishReason: candidate?.finishReason,
        usage: data?.usageMetadata,
      };
    },
  };
}

/** Build the user turn that returns tool results to Gemini. */
export function functionResponseTurn(results) {
  return {
    role: 'user',
    parts: results.map(({ id, name, response }) => ({
      functionResponse: { ...(id ? { id } : {}), name, response: { result: response } },
    })),
  };
}
