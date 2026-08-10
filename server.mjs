import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DEFAULT_UPSTREAM = 'https://agent.vlm.run/v1';
const DEFAULT_MODEL = 'vlmrun-orion-2:opus-5';

export function csv(value) {
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

export function config(env = process.env) {
  const upstreamBase = (env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const models = csv(env.MODELS);
  const defaultModel = String(env.DEFAULT_MODEL || models[0] || DEFAULT_MODEL).trim();

  return {
    host: env.HOST || '127.0.0.1',
    port: positiveInt(env.PORT, 8787),
    apiKey: env.API_KEY || '',
    corsOrigin: env.CORS_ORIGIN || '*',
    upstreamBase,
    chatEndpoint: env.CHAT_COMPLETIONS_URL || `${upstreamBase}/chat/completions`,
    modelEndpoint: env.MODEL_ENDPOINT || `${upstreamBase}/models`,
    defaultModel,
    models: [...new Set([defaultModel, ...models])],
    sessionToken: env.VLM_SESSION_TOKEN || '',
    sessionId: env.VLM_SESSION_ID || '',
    browserFingerprint: env.VLM_BROWSER_FINGERPRINT || '',
    toolsets: csv(env.VLM_TOOLSETS),
    preview: bool(env.VLM_PREVIEW, true),
    origin: env.VLM_ORIGIN || 'https://chat.vlm.run',
    referer: env.VLM_REFERER || 'https://chat.vlm.run/',
    userAgent: env.VLM_USER_AGENT || 'vlmrun-openai-proxy',
    apiBaseUrl: env.VLM_API_BASE_URL || upstreamBase,
    timeoutMs: positiveInt(env.UPSTREAM_TIMEOUT_MS, 120000),
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, 10 * 1024 * 1024)
  };
}

export function normalizeModelIds(payload) {
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

export function modelList(ids) {
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

function json(res, status, body, configured) {
  res.writeHead(status, {
    ...cors(configured),
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
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

function authorized(req, configured) {
  if (!configured.apiKey) return true;
  const bearer = String(req.headers.authorization || '');
  return bearer === `Bearer ${configured.apiKey}` || req.headers['x-api-key'] === configured.apiKey;
}

function upstreamHeaders(configured, accept = 'application/json') {
  const headers = {
    accept,
    'content-type': 'application/json',
    'user-agent': configured.userAgent,
    origin: configured.origin,
    referer: configured.referer,
    'x-api-base-url': configured.apiBaseUrl
  };
  if (configured.browserFingerprint) headers['x-browser-fingerprint'] = configured.browserFingerprint;
  return headers;
}

function timeoutSignal(milliseconds) {
  return AbortSignal.timeout(milliseconds);
}

async function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function fetchModels(configured, fetchImpl) {
  try {
    const response = await fetchImpl(configured.modelEndpoint, {
      headers: upstreamHeaders(configured),
      signal: timeoutSignal(configured.timeoutMs)
    });
    if (response.ok) {
      const remoteIds = normalizeModelIds(await response.json());
      if (remoteIds.length) return remoteIds;
    }
  } catch {
    // The fallback is intentional: VLM Run deployments may not expose /models.
  }
  return configured.models;
}

function forwardedBody(body, configured) {
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
    session_id: body.session_id || configured.sessionId || randomUUID(),
    ...(body.session_token || !configured.sessionToken ? {} : { session_token: configured.sessionToken }),
    ...(body.preview === undefined ? { preview: configured.preview } : {}),
    ...(body.toolsets === undefined && configured.toolsets.length ? { toolsets: configured.toolsets } : {})
  };
}

async function proxyChat(req, res, configured, fetchImpl) {
  let body;
  try {
    body = JSON.parse(await readBody(req, configured.maxBodyBytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  const requestBody = forwardedBody(body, configured);
  const streaming = requestBody.stream === true;
  const response = await fetchImpl(configured.chatEndpoint, {
    method: 'POST',
    headers: upstreamHeaders(configured, streaming ? 'text/event-stream' : 'application/json'),
    body: JSON.stringify(requestBody),
    signal: timeoutSignal(configured.timeoutMs)
  });

  const headers = {
    ...cors(configured),
    'content-type': response.headers.get('content-type') || (streaming ? 'text/event-stream' : 'application/json')
  };
  if (streaming) {
    headers['cache-control'] = 'no-cache';
    headers.connection = 'keep-alive';
    headers['x-accel-buffering'] = 'no';
  }
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();

  if (streaming) {
    Readable.fromWeb(response.body).pipe(res);
  } else {
    res.end(Buffer.from(await response.arrayBuffer()));
  }
}

export function createServer({ env = process.env, fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const configured = config(env);
    res.setHeader('x-content-type-options', 'nosniff');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(configured));
      return res.end();
    }

    try {
      if (!authorized(req, configured)) {
        return json(res, 401, errorBody('Invalid API key', 'authentication_error'), configured);
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return json(res, 200, { ok: true }, configured);
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(res, 200, modelList(await fetchModels(configured, fetchImpl)), configured);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
        const requestedId = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        const ids = await fetchModels(configured, fetchImpl);
        if (!ids.includes(requestedId)) {
          return json(res, 404, errorBody(`Model '${requestedId}' not found`, 'not_found_error'), configured);
        }
        return json(res, 200, modelList([requestedId]).data[0], configured);
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await proxyChat(req, res, configured, fetchImpl);
      }

      return json(res, 404, errorBody('Not found', 'invalid_request_error'), configured);
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return json(res, 504, errorBody('Upstream request timed out', 'timeout_error'), configured);
      }
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
        return json(res, 502, errorBody('Unable to reach upstream service', 'upstream_error'), configured);
      }
      console.error(error);
      return json(res, error instanceof HttpError ? error.status : 500,
        errorBody(error instanceof HttpError ? error.message : 'Internal server error'), configured);
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const configured = config();
  createServer().listen(configured.port, configured.host, () => {
    console.log(`vlmrun-openai-proxy listening on http://${configured.host}:${configured.port}`);
  });
}
