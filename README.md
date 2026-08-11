# VLM Run OpenAI-Compatible Worker

Cloudflare Worker proxy for VLM Run with OpenAI-compatible model discovery and chat completion endpoints.

Released under the [MIT License](LICENSE).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/banana2556/vlmrun2api)

## Features

- OpenAI-compatible `chat/completions` API
- Streaming responses with Server-Sent Events
- Dynamic model discovery through an upstream `/models` endpoint
- Configurable fallback model list
- VLM Run session and toolset forwarding
- Anonymous per-request session, token, and fingerprint generation
- API key authentication
- CORS configuration
- Request size and upstream timeout limits
- Cloudflare Worker observability

## Architecture

```text
OpenAI client
    |
    v
Cloudflare Worker
    |-- API key authentication
    |-- /v1/models
    |-- /v1/chat/completions
    |-- SSE response streaming
    |
    v
VLM Run API
```

The Worker does not store conversations, model responses, or session state. Each chat request receives a new `session_id`, session token, and browser fingerprint. Client-provided identity values are ignored.

## Requirements

- Node.js 20.6 or later
- npm
- Cloudflare account with Workers access
- Wrangler 4 or later
- VLM Run API access

## Installation

```powershell
npm ci
```

## Configuration

### Public configuration

Non-secret configuration is stored in [wrangler.jsonc](wrangler.jsonc).

| Variable | Default | Description |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | `https://agent.vlm.run/v1` | Upstream API base URL |
| `CHAT_COMPLETIONS_URL` | `https://agent.vlm.run/v1/chat/completions` | Upstream chat completion endpoint |
| `MODEL_ENDPOINT` | `https://agent.vlm.run/v1/models` | Upstream model list endpoint |
| `DEFAULT_MODEL` | `vlmrun-orion-2:opus-5` | Model used when a request omits `model` |
| `MODELS` | `vlmrun-orion-2:opus-5` | Comma-separated fallback model IDs |
| `VLM_TOOLSETS` | `core,document,image,image-gen,video,viz,web,world-gen` | Comma-separated toolsets |
| `VLM_PREVIEW` | `true` | Default preview flag |
| `VLM_ORIGIN` | `https://chat.vlm.run` | Upstream `Origin` header |
| `VLM_REFERER` | `https://chat.vlm.run/` | Upstream `Referer` header |
| `VLM_USER_AGENT` | `vlmrun-openai-proxy-worker` | Upstream `User-Agent` header |
| `VLM_API_BASE_URL` | `UPSTREAM_BASE_URL` | Upstream `x-api-base-url` header |
| `CORS_ORIGIN` | `*` | Allowed browser origin |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `MAX_BODY_BYTES` | `10485760` | Maximum JSON request size |

### Secrets

The Worker reads secrets from the Cloudflare environment.

| Secret | Required | Description |
| --- | --- | --- |
| `API_KEY` | No | Optional client authentication secret; omit for anonymous access |
| `VLM_SESSION_TOKEN` | No | Optional issued VLM Run token; omit for per-request anonymous generation |

Optional production secrets:

```powershell
npx wrangler secret put API_KEY
npx wrangler secret put VLM_SESSION_TOKEN
```

List configured secret names:

```powershell
npx wrangler secret list
```

### Local variables

```powershell
Copy-Item .dev.vars.example .dev.vars
```

`.dev.vars` is ignored by Git. Leave `API_KEY` and `VLM_SESSION_TOKEN` unset for anonymous mode.

## Local development

Start the local Worker:

```powershell
npm run dev
```

The default local address is `http://127.0.0.1:8787`.

The local Worker uses the values from `wrangler.jsonc` and `.dev.vars`. Anonymous requests do not require an authorization header.

## API reference

### Health check

```http
GET /healthz
```

Response:

```json
{
  "ok": true
}
```

### List models

```http
GET /v1/models
```

The Worker requests `MODEL_ENDPOINT` on every call. It accepts these upstream response shapes:

```json
{
  "data": [{ "id": "model-id" }]
}
```

```json
{
  "models": ["model-id"]
}
```

```json
["model-id"]
```

When the upstream endpoint is unavailable or returns no model IDs, the Worker returns the IDs in `MODELS`.

Response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "vlmrun-orion-2:opus-5",
      "object": "model",
      "created": 1780000000,
      "owned_by": "vlmrun"
    }
  ]
}
```

### Retrieve a model

```http
GET /v1/models/{model}
```

The model must be present in the current dynamic model list or configured fallback list.

### Chat completions

Supported paths:

- `POST /v1/chat/completions`
- `POST /v1/openai/chat/completions`

Required request fields:

| Field | Type | Description |
| --- | --- | --- |
| `messages` | array | OpenAI-compatible message list |
| `model` | string | Upstream model ID; defaults to `DEFAULT_MODEL` when omitted |

Example:

```bash
curl https://<worker-domain>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"vlmrun-orion-2:opus-5","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Streaming request:

```bash
curl https://<worker-domain>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"vlmrun-orion-2:opus-5","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Streaming responses use `text/event-stream` and end with:

```text
data: [DONE]
```

For every chat request, the Worker generates a new 36-character `session_id`, a new 40-character anonymous session token, and a new 32-character hexadecimal `x-browser-fingerprint` header for the upstream request. Client-provided `session_id` and `session_token` values are replaced.

The Worker preserves additional request fields, including:

- `stream`
- `temperature`
- `max_tokens`
- `response_format`
- multimodal `content`
- `session_id`
- `session_token`
- `preview`
- `toolsets`
- provider-specific fields

When `VLM_SESSION_TOKEN` is configured, it replaces the generated anonymous session token. When `preview` or `toolsets` are omitted, the corresponding Worker configuration is injected.

### OpenAI SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.API_KEY || "anonymous",
  baseURL: "https://<worker-domain>/v1"
});

const completion = await client.chat.completions.create({
  model: "vlmrun-orion-2:opus-5",
  messages: [{ role: "user", content: "Hello" }]
});

console.log(completion.choices[0].message);
```

### Authentication headers

Either header is accepted:

```http
Authorization: Bearer <API_KEY>
```

```http
x-api-key: <API_KEY>
```

If `API_KEY` is not configured, the Worker allows anonymous requests. Configure `API_KEY` when client authentication is required.

### Error responses

Errors use an OpenAI-compatible shape:

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error"
  }
}
```

| Status | Type | Meaning |
| --- | --- | --- |
| `400` | `invalid_request_error` | Invalid JSON, model, or messages |
| `401` | `authentication_error` | Missing or invalid API key when `API_KEY` is configured |
| `404` | `not_found_error` | Model or route not found |
| `413` | `invalid_request_error` | Request exceeds `MAX_BODY_BYTES` |
| `502` | `upstream_error` | Upstream request failed |
| `504` | `timeout_error` | Upstream request exceeded `UPSTREAM_TIMEOUT_MS` |

Upstream HTTP status codes and response bodies are preserved for chat completion requests.

## Production deployment

Authenticate Wrangler:

```powershell
npx wrangler login
npx wrangler whoami
```

Validate the Worker:

```powershell
npx wrangler types
npx wrangler types --check
npx wrangler deploy --dry-run
```

Configure production secrets:

```powershell
npx wrangler secret put API_KEY
npx wrangler secret put VLM_SESSION_TOKEN
```

Deploy:

```powershell
npx wrangler deploy
```

Wrangler prints the deployed Worker URL after a successful deployment.

### Production settings

Set these values before deployment:

1. Leave `API_KEY` unset for anonymous access, or configure it as a Worker secret for client authentication.
2. Leave `VLM_SESSION_TOKEN` unset for generated anonymous sessions, or configure an issued token as a Worker secret when required by the upstream account.
3. Set `CORS_ORIGIN` to the exact browser origin when browser access is required.
4. Set `MODEL_ENDPOINT` to the model endpoint used by the VLM Run account.
5. Set `MODELS` to a known fallback list.
6. Set `UPSTREAM_TIMEOUT_MS` and `MAX_BODY_BYTES` for the expected workload.

### Logs

```powershell
npx wrangler tail vlmrun-openai-proxy
```

The Worker configuration enables logs and traces through `wrangler.jsonc`.

## Testing

Unit tests:

```powershell
npm test
```

End-to-end test:

```powershell
npm run test:e2e
```

The E2E test starts Wrangler in local mode, starts an isolated upstream test server, verifies anonymous access, checks dynamic model discovery, sends two chat completion requests, validates SSE output, and verifies that session IDs, session tokens, and fingerprints rotate between requests.

Deployment validation:

```powershell
npx wrangler types --check
npx wrangler deploy --dry-run
```

## Project structure

```text
src/index.js              Worker entry point
wrangler.jsonc            Worker configuration
.dev.vars.example         Local variable template
test/e2e.mjs              Wrangler E2E test
test/mock-upstream.mjs    E2E upstream server
test/server.test.mjs      Unit tests for shared proxy logic
worker-configuration.d.ts Generated Wrangler types
```

## Production limitations

- Model availability is controlled by the VLM Run account and upstream endpoint.
- Anonymous session generation depends on the upstream accepting generated session tokens.
- The Worker does not implement persistent conversation storage.
- The Worker does not implement per-user quotas or rate limiting.
- Public traffic should be protected with `API_KEY`, Cloudflare WAF, or Cloudflare Rate Limiting.
- `CORS_ORIGIN=*` is suitable for development and should be restricted for browser-based production clients.
