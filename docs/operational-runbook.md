# Operations runbook

## What to monitor

Emit structured JSON logs with `requestId`, route, status code, duration, client key classification, upstream hostname, cache outcome, and error code. Never log request bodies or credentials.

Recommended metrics:

- request count and error rate by route/status/error code;
- p50/p95/p99 API latency, split into cache hits and misses;
- upstream DNS, connect, time-to-first-byte, body-read, timeout, and redirect counts;
- cache hit ratio, cache evictions, and Redis latency/errors;
- rate-limit rejections and audit-capacity rejections;
- active workers, queue depth, socket count, memory/CPU, and event-loop lag;
- readiness failures, deployment version, and replica count.

## Alerts

Start with alerts that page on sustained customer impact, not single noisy requests:

| Alert | Initial threshold | Response |
| --- | --- | --- |
| API 5xx | >2% for 5 minutes | Check deployment and upstream dependency errors. |
| SLA breach | p95 >3s for 10 minutes or >5s error rate above baseline | Check queue depth, upstream latency, and replica capacity. |
| Capacity saturation | queue depth >80% or active workers at 100% for 5 minutes | Scale out; investigate slow origins and timeout rate. |
| Rate limiter/cache dependency | Redis error rate >1% for 5 minutes | Check Redis health; fail closed for limits, tolerate cache misses. |
| SSRF safety | any unexpected private-target allow or spike in unsafe-target rejects | Treat as security incident; review resolver and edge policy. |
| Readiness | >1 replica unavailable for 5 minutes | Stop rollout and restore capacity. |

Thresholds should be calibrated after a load test using the actual deployment region and network path.

## Bad deploy rollback

1. Confirm the signal with request IDs and compare the current version to the last known good version.
2. Stop promotion immediately. Keep the canary isolated if the platform supports traffic weights.
3. Roll back by promoting the last immutable container/artifact. On Vercel, use `vercel rollback` or promote the previously validated deployment; on a container platform, redeploy the previous image digest.
4. Verify `/healthz`, `/readyz`, a known public audit, error rate, queue depth, and p95 latency.
5. Preserve logs and deployment metadata, then open a follow-up with the triggering test or missing guardrail. Do not retry a bad artifact by changing only the timeout.

## Failure modes and mitigations

### 1. A customer-controlled origin hangs or streams an oversized body

Impact: worker slots, sockets, and memory are consumed; queue latency rises.

Mitigation: one absolute timeout covers fetch and body read, `AbortController` cancels work, response bytes are capped, redirects are limited, and the queue is finite. The result is not cached when the audit fails. Alert on timeout rate and worker saturation.

### 2. Shared cache/rate-limit state is unavailable or inconsistent across replicas

Impact: duplicate upstream work, uneven client limits, or a sudden cache miss storm.

Mitigation: Redis is the single shared backing store with timeouts and dashboards. Cache failure degrades to a bounded origin fetch; rate-limit failure fails closed with a retryable `503` to protect the service. Use short-lived locks and jittered TTLs to reduce stampedes. The current process-local implementation is intentionally only a single-instance default.

### 3. A deployment leaks resources or changes the response contract

Impact: rising latency, 5xxs, or incorrect results across all replicas.

Mitigation: CI blocks promotion on typecheck/tests/build, smoke-test the artifact, release by canary/gradual traffic, keep readiness separate from liveness, cap resources, and retain the previous immutable artifact for instant rollback. Alert on version-correlated error and latency changes.

## Security notes

URL validation is part of the audit boundary, not a UI feature. Resolve every hostname before fetching and on every redirect; reject loopback, link-local, private, documentation, multicast, and unspecified address ranges. In a multi-tenant production network, add egress firewall rules as a second control and do not rely on DNS checks alone.
