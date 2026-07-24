import { describe, expect, it, vi } from "vitest";
import { AuditService, AuditServiceConfig } from "../src/audit-service.js";

const config = (overrides: Partial<AuditServiceConfig> = {}): AuditServiceConfig => ({
  requestTimeoutMs: 500,
  maxRedirects: 2,
  maxResponseBytes: 10_000,
  auditConcurrency: 2,
  auditQueueLimit: 2,
  cacheTtlMs: 10_000,
  cacheMaxEntries: 10,
  ...overrides,
});

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

describe("AuditService", () => {
  it("normalizes the URL, extracts HTML metadata, and caches repeat audits", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html><title>  Example &amp; Co </title></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const service = new AuditService(config(), { fetchImpl, dnsLookup: publicDns });

    const first = await service.audit("HTTPS://Example.com#tracking");
    const second = await service.audit("https://example.com/");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(first.result).toMatchObject({
      url: "https://example.com/",
      status: 200,
      ok: true,
      title: "Example & Co",
      contentLengthBytes: expect.any(Number),
    });
  });

  it("returns non-2xx upstream responses as valid audit results", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/plain" },
    }));
    const service = new AuditService(config(), { fetchImpl, dnsLookup: publicDns });

    const response = await service.audit("https://example.com/missing");

    expect(response.result).toMatchObject({ status: 404, statusText: "Not Found", ok: false, title: null });
  });

  it("rejects private targets before making an outbound request", async () => {
    const fetchImpl = vi.fn();
    const service = new AuditService(config(), { fetchImpl, dnsLookup: publicDns });

    await expect(service.audit("http://127.0.0.1:8080/admin")).rejects.toMatchObject({
      code: "UNSAFE_URL",
      statusCode: 400,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("converts a hanging upstream into a timeout", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = new AuditService(config({ requestTimeoutMs: 20 }), { fetchImpl, dnsLookup: publicDns });

    await expect(service.audit("https://example.com/slow")).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      statusCode: 504,
    });
  });

  it("coalesces concurrent audits for the same URL", async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const service = new AuditService(config(), { fetchImpl, dnsLookup: publicDns });

    const first = service.audit("https://example.com");
    const second = service.audit("https://example.com/");
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(new Response("<title>Shared</title>", { headers: { "content-type": "text/html" } }));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.result.title).toBe("Shared");
    expect(secondResult.result.title).toBe("Shared");
    expect(firstResult.cache).toBe("miss");
    expect(secondResult.cache).toBe("miss");
  });

  it("rejects work when the bounded queue is full", async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const service = new AuditService(config({ auditConcurrency: 1, auditQueueLimit: 0 }), { fetchImpl, dnsLookup: publicDns });

    const first = service.audit("https://one.example");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.audit("https://two.example")).rejects.toMatchObject({ code: "AUDIT_CAPACITY", statusCode: 503 });
    release(new Response("ok"));
    await first;
  });

  it("follows redirects within the configured limit", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://example.com/final" } }))
      .mockResolvedValueOnce(new Response("<title>Final</title>", { status: 200, headers: { "content-type": "text/html" } }));
    const service = new AuditService(config(), { fetchImpl, dnsLookup: publicDns });

    const response = await service.audit("https://example.com/start");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.result.redirects).toEqual(["https://example.com/final"]);
    expect(response.result.url).toBe("https://example.com/final");
  });
});
