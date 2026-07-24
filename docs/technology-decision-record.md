# Technology decision record

## ADR-001: TypeScript on Node.js with Fastify

Decision: use TypeScript on Node.js 20+ and Fastify 5.

Why: the service is I/O-bound, Node's built-in `fetch`, `AbortController`, DNS APIs, and Web Streams cover the core network path, and Fastify gives request IDs, structured Pino logging, lifecycle hooks, and low-overhead HTTP handling without a large framework surface.

Rejected alternative: Express. Express is familiar and viable, but it would require assembling request-ID, logging, body parsing, and several error-handling conventions that Fastify already makes explicit. The choice is about defaults and consistency, not a claim that Express cannot scale.

## ADR-002: Native fetch with manual redirects

Decision: use the Node runtime's native `fetch` with `redirect: manual`.

Why: no extra HTTP client is needed; manual redirects let the service validate every redirect destination for SSRF before following it, apply one total deadline, and cap body bytes.

Rejected alternative: Axios. Axios has a good ergonomics story, but its extra dependency and automatic redirect behavior do not improve the security boundary needed here. An undici dispatcher can be added later if connection pooling needs tuning.

## ADR-003: TTL/LRU cache with in-flight coalescing

Decision: cache successful audit results by canonical URL, with configurable TTL and entry count, and share concurrent misses for the same key.

Why: repeated audits are common, and coalescing prevents a hot URL from multiplying upstream load. TTL bounds staleness; LRU bounds memory.

Rejected alternative: caching every response in a database. A relational database is durable, but durability is not valuable for a short-lived audit result and would add latency and operational coupling. The scale design moves the same interface to Redis so replicas share results.

## ADR-004: Sliding-window rate limit

Decision: use a per-client in-memory sliding window by default, with response headers and `Retry-After` on rejection.

Why: it has simple, understandable behavior and zero setup for local use. The map is cleaned up and remains bounded by active clients.

Rejected alternative: a fixed-window counter. Fixed windows are simpler but allow boundary bursts roughly twice the configured limit. Redis is the chosen production backing store for multiple replicas, with an atomic script or token bucket.

## ADR-005: Bounded synchronous concurrency instead of an unbounded durable queue

Decision: keep the customer-facing endpoint synchronous and bound outbound work with a semaphore plus a finite FIFO queue.

Why: the result is useful in the same request and the SLA is response-time based. A full queue returns an explicit retryable error, protecting sockets and memory from slow origins.

Rejected alternative: always enqueue to BullMQ/Redis Streams and return `202`. That is the right model for long-running audits, but it changes the API contract and makes a successful submission different from a completed audit. The architecture document reserves that model for a separate async endpoint.

## ADR-006: GitHub Actions for CI

Decision: run `npm ci`, typecheck, tests, and build on every push and pull request.

Why: the repository is Node-based, GitHub Actions is native to the requested public repository, and the job is intentionally small enough to finish quickly.

Rejected alternative: a hosted CI vendor. It would add another integration and secret surface without improving the required verification for this task.
