'use strict';

/**
 * AI providers for question generation. Both return { data (parsed JSON), usage: { input, output }, model }.
 *
 * - Anthropic (Claude): official SDK, streamed (long JSON outputs), structured outputs via output_config.format,
 *   adaptive thinking (default on current models) with configurable effort, and server-side refusal fallbacks.
 * - OpenAI (or an OpenAI-compatible endpoint): Chat Completions with a strict json_schema response format.
 * Keys come from Settings → AI (stored encrypted) and are never logged.
 */
const Anthropic = require('@anthropic-ai/sdk');
const settings = require('../settings');

class AiError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, lower cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, lowest cost' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 — most capable, highest cost' },
];
// Models that support the "default" server-side fallback form on refusals.
const FALLBACK_DEFAULT_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']);

async function anthropicClient(apiKey) {
  const key = apiKey || (await settings.get('ai.anthropic_api_key'));
  if (!key) throw new AiError('No Anthropic API key is configured. Add it in Settings → AI.');
  return new Anthropic({ apiKey: key, maxRetries: 2, timeout: 15 * 60 * 1000 });
}

function mapAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new AiError('The Anthropic API key was rejected. Check it in Settings → AI.', { status: 401 });
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('This Anthropic API key cannot use the selected model.', { status: 403 });
  if (err instanceof Anthropic.NotFoundError) return new AiError('The selected Claude model was not found. Choose another model in Settings → AI.', { status: 404 });
  if (err instanceof Anthropic.RateLimitError) return new AiError('Anthropic rate limit reached. Try again in a minute.', { retryable: true, status: 429 });
  if (err instanceof Anthropic.BadRequestError) return new AiError(`Anthropic rejected the request: ${err.message}`, { status: 400 });
  if (err instanceof Anthropic.APIError) return new AiError(`Anthropic API error ${err.status || ''}: ${err.message}`, { retryable: (err.status || 500) >= 500, status: err.status });
  if (err instanceof Anthropic.APIConnectionError) return new AiError('Could not reach the Anthropic API (network).', { retryable: true });
  return err;
}

async function callAnthropic({ system, prompt, schema, model, effort, apiKey }) {
  const client = await anthropicClient(apiKey);
  const useModel = model || (await settings.get('ai.anthropic_model')) || 'claude-opus-5-5';
  const params = {
    model: useModel,
    max_tokens: 64000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema }, effort: effort || (await settings.get('ai.anthropic_effort')) || 'high' },
  };
  if (FALLBACK_DEFAULT_MODELS.has(useModel)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let message;
  try {
    message = await client.beta.messages.stream(params).finalMessage();
  } catch (err) {
    throw mapAnthropicError(err);
  }
  if (message.stop_reason === 'refusal') {
    const cat = message.stop_details && message.stop_details.category;
    throw new AiError(`Claude declined to write these questions${cat ? ` (safety category: ${cat})` : ''}. Rephrase the prompt to focus on defensive, educational content.`);
  }
  if (message.stop_reason === 'max_tokens') throw new AiError('The response was too long and was cut off. Ask for fewer questions per run.', { retryable: false });
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('Claude returned output that is not valid JSON.', { retryable: true });
  }
  return { data, usage: { input: message.usage.input_tokens || 0, output: message.usage.output_tokens || 0 }, model: message.model || useModel };
}

async function callOpenAi({ system, prompt, schema, model, apiKey, baseUrl }) {
  const key = apiKey || (await settings.get('ai.openai_api_key'));
  if (!key) throw new AiError('No OpenAI API key is configured. Add it in Settings → AI.');
  const useModel = model || (await settings.get('ai.openai_model'));
  if (!useModel) throw new AiError('No OpenAI model is configured. Enter one in Settings → AI.');
  const base = (baseUrl || (await settings.get('ai.openai_base_url')) || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'question_set', strict: true, schema } },
      }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
  } catch (err) {
    throw new AiError(`Could not reach the OpenAI API: ${err.message}`, { retryable: true });
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (body.error && body.error.message) || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new AiError('The OpenAI API key was rejected. Check it in Settings → AI.', { status: 401 });
    if (resp.status === 404) throw new AiError(`OpenAI model “${useModel}” was not found.`, { status: 404 });
    throw new AiError(`OpenAI error: ${msg}`, { retryable: resp.status === 429 || resp.status >= 500, status: resp.status });
  }
  const choice = body.choices && body.choices[0];
  if (!choice) throw new AiError('OpenAI returned no answer.', { retryable: true });
  if (choice.message && choice.message.refusal) throw new AiError(`The model declined: ${choice.message.refusal}`);
  if (choice.finish_reason === 'length') throw new AiError('The response was too long and was cut off. Ask for fewer questions per run.');
  let data;
  try {
    data = JSON.parse(choice.message.content);
  } catch {
    throw new AiError('OpenAI returned output that is not valid JSON.', { retryable: true });
  }
  return { data, usage: { input: (body.usage && body.usage.prompt_tokens) || 0, output: (body.usage && body.usage.completion_tokens) || 0 }, model: body.model || useModel };
}

/** Single entry point (tests replace this with a fake). */
async function generateJson(provider, args) {
  if (provider === 'anthropic') return callAnthropic(args);
  if (provider === 'openai') return callOpenAi(args);
  throw new AiError(`Unknown AI provider “${provider}”.`);
}

/** Validates keys/model with a cheap call. Returns null when OK, otherwise a message. */
async function testConnection(provider) {
  try {
    if (provider === 'anthropic') {
      const client = await anthropicClient();
      await client.models.retrieve((await settings.get('ai.anthropic_model')) || 'claude-opus-5-5');
      return null;
    }
    const key = await settings.get('ai.openai_api_key');
    const model = await settings.get('ai.openai_model');
    if (!key || !model) return 'Enter the OpenAI API key and model first.';
    const base = ((await settings.get('ai.openai_base_url')) || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const resp = await fetch(`${base}/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (resp.status === 401) return 'The OpenAI API key was rejected.';
    if (resp.status === 404) return `OpenAI model “${model}” was not found.`;
    if (!resp.ok) return `OpenAI returned HTTP ${resp.status}.`;
    return null;
  } catch (err) {
    const mapped = provider === 'anthropic' ? mapAnthropicError(err) : err;
    return mapped.message;
  }
}

async function availableProviders() {
  await settings.ensureLoaded();
  const out = [];
  if (await settings.isSet('ai.anthropic_api_key')) out.push({ id: 'anthropic', label: 'Claude (Anthropic)', model: settings.getSync('ai.anthropic_model') });
  if ((await settings.isSet('ai.openai_api_key')) && settings.getSync('ai.openai_model')) out.push({ id: 'openai', label: 'OpenAI', model: settings.getSync('ai.openai_model') });
  return out;
}

module.exports = { generateJson, testConnection, availableProviders, AiError, ANTHROPIC_MODELS };
