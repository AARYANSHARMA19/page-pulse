# Page Pulse

Page Pulse is a small URL-audit service built to be dependable under ordinary production pressure: it validates targets, blocks private-network destinations, applies a deadline to outbound work, bounds concurrency, coalesces duplicate in-flight audits, caches completed results, rate-limits clients, and returns predictable JSON errors.

The root route is a deliberately minimal customer-facing page. The API is the product; the page is a useful way to exercise it.

## Run it

Requirements: Node.js 20 or newer.

```bash
npm ci
cp .env.example .env
npm run dev
```

Open <http://localhost:3000> or call the API directly:

```bash
curl -i http://localhost:3000/api/audit \
  -H 'content-type: application/json' \
  -H 'x-request-id: demo-123' \
  -d '{"url":"https://example.com"}'
```

For a production-shaped local run:

```bash
npm run check
npm run build
npm start
```

Docker is also supported:

```bash
docker build -t page-pulse .
docker run --rm -p 3000:3000 page-pulse
```

## API contract

### `POST /api/audit`

Request body:

```json
{
  "url": "https://example.com/docs"
}
```

The URL must be an absolute `http://` or `https://` URL. Fragments are removed during canonicalization. URLs with credentials, private IPs, localhost names, and hostnames resolving to private/special-use addresses are rejected to reduce SSRF risk.

Successful response (`200`):

```json
{
  "data": {
    "url": "https://example.com/docs",
    "status": 200,
    "statusText": "OK",
    "ok": true,
    "responseTimeMs": 184,
    "contentType": "text/html; charset=UTF-8",
    "contentLengthBytes": 12543,
    "title": "Example Domain",
    "redirects": [],
    "checkedAt": "2026-07-25T00:00:00.000Z"
  },
  "meta": {
    "cache": "miss",
    "requestId": "demo-123"
  }
}
```

`ok` describes the upstream HTTP response. A `404`, for example, is still a valid audit result with `ok: false`; it is not an API failure. Redirects are followed manually up to `MAX_REDIRECTS`, and `url` is the final URL.

Error response shape:

```json
{
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "message": "The target URL did not respond within the timeout."
  },
  "requestId": "demo-123"
}
```

The service uses these stable error codes:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` / `INVALID_URL` / `UNSAFE_URL` | The request or target is not allowed. |
| 429 | `RATE_LIMITED` | The client window is exhausted. `Retry-After` is included. |
| 502 | `DNS_LOOKUP_FAILED` / `UPSTREAM_REQUEST_FAILED` / `UPSTREAM_RESPONSE_FAILED` / `TOO_MANY_REDIRECTS` | The target could not be audited reliably. |
| 503 | `AUDIT_CAPACITY` | The bounded audit queue is full. `Retry-After` is included. |
| 504 | `UPSTREAM_TIMEOUT` | The configured audit deadline was exceeded. |
| 404 | `NOT_FOUND` | The route does not exist. |
| 500 | `INTERNAL_ERROR` | An unexpected server failure. The response does not expose a stack trace. |

Every response includes `X-Request-Id`. A valid client-provided request ID is preserved; otherwise the service generates one. Successful audit calls also return rate-limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

### Operational endpoints

- `GET /healthz` is a lightweight liveness check.
- `GET /readyz` reports that the process is ready and includes current local capacity counters.

## Runtime controls

All controls are environment variables; `.env.example` is the complete list. The important defaults are:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `REQUEST_TIMEOUT_MS` | `5000` | Deadline for each audit, including response body reading. |
| `MAX_REDIRECTS` | `5` | Manual redirect limit. |
| `MAX_RESPONSE_BYTES` | `1000000` | Maximum response bytes consumed per audit. |
| `AUDIT_CONCURRENCY` | `32` | Maximum simultaneous outbound audits per process. |
| `AUDIT_QUEUE_LIMIT` | `128` | Maximum waiting audit jobs per process. |
| `CACHE_TTL_MS` | `60000` | Result cache lifetime; `0` disables caching. |
| `CACHE_MAX_ENTRIES` | `1000` | LRU cache bound per process. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | In-memory sliding-window limit per client IP. |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops used to derive `request.ip`. |

The default cache and rate limiter are process-local, which makes the default runnable with no external services. For multiple replicas, move both to Redis as described in [the scale architecture](docs/architecture.md); otherwise a client can receive different limits and cache hit rates depending on which replica receives a request.

## Project shape

```text
src/
  app.ts              Fastify app, routes, request IDs, errors
  audit-service.ts    outbound audit flow, redirects, caching/coalescing
  url.ts              canonicalization and SSRF target checks
  concurrency.ts      bounded semaphore and queue
  rate-limit.ts       sliding-window client limiter
  cache.ts            TTL/LRU cache
  server.ts           process lifecycle
tests/                unit and HTTP contract tests; no live network dependency
docs/                 scale architecture, decisions, and operations
public/               small browser client with required footer credit
```

## Engineering notes

- Outbound redirects are manual so every redirect target is validated before a second request.
- A response status such as `500` is data, not a thrown application error; DNS failures, timeouts, body-read failures, and capacity failures are errors.
- Identical concurrent cache misses share one in-flight promise, preventing a thundering herd on a hot URL.
- Logs are JSON through Fastify/Pino and include Fastify's request ID plus audit lifecycle events. URLs are reduced to hostnames in request logs.
- The in-memory state is intentionally bounded. It is an implementation default, not a claim that process memory is sufficient for a multi-replica deployment.

See [Architecture and scale plan](docs/architecture.md), [Technology decision record](docs/technology-decision-record.md), and [Operations runbook](docs/operational-runbook.md).

## Verification

```bash
npm run typecheck
npm test
npm run build
```

GitHub Actions runs all three checks on every push and pull request via `.github/workflows/ci.yml`.

## Credit

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
