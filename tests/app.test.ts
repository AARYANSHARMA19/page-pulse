import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuditResult } from "../src/audit-service.js";
import { Config } from "../src/config.js";

const config: Config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  LOG_LEVEL: "silent",
  TRUST_PROXY_HOPS: 0,
  REQUEST_TIMEOUT_MS: 500,
  MAX_REDIRECTS: 2,
  MAX_RESPONSE_BYTES: 10_000,
  AUDIT_CONCURRENCY: 2,
  AUDIT_QUEUE_LIMIT: 2,
  CACHE_TTL_MS: 10_000,
  CACHE_MAX_ENTRIES: 10,
  RATE_LIMIT_MAX: 2,
  RATE_LIMIT_WINDOW_MS: 60_000,
};

const result: AuditResult = {
  url: "https://example.com/",
  status: 200,
  statusText: "OK",
  ok: true,
  responseTimeMs: 42,
  contentType: "text/html",
  contentLengthBytes: 100,
  title: "Example",
  redirects: [],
  checkedAt: "2026-01-01T00:00:00.000Z",
};

function makeApp(overrides: Partial<Config> = {}) {
  let calls = 0;
  const auditService = {
    audit: async () => {
      calls += 1;
      return { result, cache: calls > 1 ? "hit" as const : "miss" as const };
    },
    getStats: () => ({ cacheEntries: 1, inFlight: 0, concurrency: { active: 0, queued: 0, limit: 2, queueLimit: 2 } }),
  };
  return { app: buildApp({ config: { ...config, ...overrides }, auditService: auditService as never }), auditService };
}

describe("HTTP API", () => {
  it("returns a health check and preserves a supplied request ID", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "test-request-1" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "page-pulse" });
    expect(response.headers["x-request-id"]).toBe("test-request-1");
    await app.close();
  });

  it("returns the documented envelope for a valid audit", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/audit",
      headers: { "content-type": "application/json", "x-request-id": "audit-123" },
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: result, meta: { cache: "miss", requestId: "audit-123" } });
    expect(response.headers["x-ratelimit-limit"]).toBe("2");
    expect(response.headers["x-request-id"]).toBe("audit-123");
    await app.close();
  });

  it("returns structured validation errors", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "POST", url: "/api/audit", payload: { url: "ftp://example.com" } });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe("INVALID_URL");
    expect(body.error.message).toContain("http://");
    expect(body.requestId).toEqual(expect.any(String));
    await app.close();
  });

  it("rate limits clients with retry metadata", async () => {
    const { app } = makeApp({ RATE_LIMIT_MAX: 1 });
    const request = { method: "POST" as const, url: "/api/audit", payload: { url: "https://example.com" } };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toEqual(expect.any(String));
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");
    expect(second.json()).toMatchObject({ error: { code: "RATE_LIMITED" }, requestId: expect.any(String) });
    await app.close();
  });

  it("returns a structured 404 for unknown routes", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" }, requestId: expect.any(String) });
    await app.close();
  });
});
