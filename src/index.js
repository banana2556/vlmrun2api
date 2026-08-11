const DEFAULT_UPSTREAM = 'https://agent.vlm.run/v1';
const DEFAULT_MODEL = 'vlmrun-orion-2:opus-5';

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

function config(env) {
  const upstreamBase = (env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const models = csv(env.MODELS);
  const defaultModel = String(env.DEFAULT_MODEL || models[0] || DEFAULT_MODEL).trim();

  return {
    apiKey: env.API_KEY || '',
    corsOrigin: env.CORS_ORIGIN || '*',
    chatEndpoint: env.CHAT_COMPLETIONS_URL || `${upstreamBase}/chat/completions`,
    modelEndpoint: env.MODEL_ENDPOINT || `${upstreamBase}/models`,
    defaultModel,
    models: [...new Set([defaultModel, ...models])],
    sessionToken: env.VLM_SESSION_TOKEN || '',
    toolsets: csv(env.VLM_TOOLSETS),
    preview: bool(env.VLM_PREVIEW, true),
    origin: env.VLM_ORIGIN || 'https://chat.vlm.run',
    referer: env.VLM_REFERER || 'https://chat.vlm.run/',
    userAgent: env.VLM_USER_AGENT || 'vlmrun-openai-proxy-worker',
    apiBaseUrl: env.VLM_API_BASE_URL || upstreamBase,
    timeoutMs: positiveInt(env.UPSTREAM_TIMEOUT_MS, 120000),
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, 10 * 1024 * 1024)
  };
}

function normalizeModelIds(payload) {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  return [...new Set(items
    .map((item) => typeof item === 'string' ? item : item?.id)
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim()))];
}

function modelList(ids) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: [...new Set(ids)].map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'vlmrun'
    }))
  };
}

function cors(configured) {
  return {
    'access-control-allow-origin': configured.corsOrigin,
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  };
}

function json(body, status, configured) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(configured),
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff'
    }
  });
}

function errorBody(message, type = 'invalid_request_error') {
  return { error: { message, type } };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function authorized(request, expected) {
  if (!expected) return true;
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    || request.headers.get('x-api-key')
    || '';
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function upstreamHeaders(configured, accept = 'application/json', fingerprint = randomHex(16)) {
  const headers = {
    accept,
    'content-type': 'application/json',
    'user-agent': configured.userAgent,
    origin: configured.origin,
    referer: configured.referer,
    'x-api-base-url': configured.apiBaseUrl,
    'x-browser-fingerprint': fingerprint
  };
  return headers;
}

async function readJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
  }
  if (!request.body) throw new HttpError(400, 'Request body must be valid JSON');

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

async function fetchModels(configured) {
  try {
    const response = await fetch(configured.modelEndpoint, {
      headers: upstreamHeaders(configured),
      signal: AbortSignal.timeout(configured.timeoutMs)
    });
    if (response.ok) {
      const remoteIds = normalizeModelIds(await response.json());
      if (remoteIds.length) return remoteIds;
    }
  } catch {
    // VLM Run deployments may not expose /models; use the configured fallback.
  }
  return configured.models;
}

function forwardedBody(body, configured, identity) {
  const model = body.model === undefined ? configured.defaultModel : body.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw new HttpError(400, 'model must be a non-empty string');
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, 'messages must be an array');
  }

  return {
    ...body,
    model: model.trim(),
    session_id: identity.sessionId,
    session_token: identity.sessionToken,
    ...(body.preview === undefined ? { preview: configured.preview } : {}),
    ...(body.toolsets === undefined && configured.toolsets.length ? { toolsets: configured.toolsets } : {})
  };
}

function requestIdentity(configured) {
  return {
    sessionId: crypto.randomUUID(),
    sessionToken: configured.sessionToken || randomHex(20),
    fingerprint: randomHex(16)
  };
}

async function proxyChat(request, configured) {
  let body = await readJson(request, configured.maxBodyBytes);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  const identity = requestIdentity(configured);
  body = forwardedBody(body, configured, identity);
  const streaming = body.stream === true;
  const response = await fetch(configured.chatEndpoint, {
    method: 'POST',
    headers: upstreamHeaders(configured, streaming ? 'text/event-stream' : 'application/json', identity.fingerprint),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(configured.timeoutMs)
  });

  const headers = new Headers(cors(configured));
  headers.set('content-type', response.headers.get('content-type') || (streaming ? 'text/event-stream' : 'application/json'));
  headers.set('x-content-type-options', 'nosniff');
  if (streaming) {
    headers.set('cache-control', 'no-cache');
    headers.set('x-accel-buffering', 'no');
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const configured = config(env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(configured) });
    }

    try {
      if (!(await authorized(request, configured.apiKey))) {
        return json(errorBody('Invalid API key', 'authentication_error'), 401, configured);
      }

      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json({ ok: true }, 200, configured);
      }

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return json(modelList(await fetchModels(configured)), 200, configured);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
        const requestedId = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        const ids = await fetchModels(configured);
        if (!ids.includes(requestedId)) {
          return json(errorBody(`Model '${requestedId}' not found`, 'not_found_error'), 404, configured);
        }
        return json(modelList([requestedId]).data[0], 200, configured);
      }

      if (request.method === 'POST' && ['/v1/chat/completions', '/v1/openai/chat/completions'].includes(url.pathname)) {
        return await proxyChat(request, configured);
      }

      return json(errorBody('Not found'), 404, configured);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error?.name === 'TimeoutError' ? 504 : 502;
      const body = error instanceof HttpError
        ? errorBody(error.message)
        : errorBody('Unable to reach upstream service', 'upstream_error');
      console.error(JSON.stringify({
        message: 'request failed',
        error: error instanceof Error ? error.message : String(error),
        path: url.pathname
      }));
      return json(body, status, configured);
    }
  }
};
