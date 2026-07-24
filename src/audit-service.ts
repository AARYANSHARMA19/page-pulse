import { performance } from "node:perf_hooks";
import { TtlLruCache } from "./cache.js";
import { Semaphore } from "./concurrency.js";
import { AppError } from "./errors.js";
import { assertPublicHostname, DnsLookup, normalizeAuditUrl } from "./url.js";

export type AuditResult = {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  responseTimeMs: number;
  contentType: string | null;
  contentLengthBytes: number;
  title: string | null;
  redirects: string[];
  checkedAt: string;
};

export type AuditResponse = { result: AuditResult; cache: "hit" | "miss" };

export type AuditServiceConfig = {
  requestTimeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
  auditConcurrency: number;
  auditQueueLimit: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function extractTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return null;
  const title = match[1]
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title.slice(0, 300) : null;
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("The request timed out.", "TimeoutError");
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), bytes: totalBytes };
}

export class AuditService {
  private readonly cache: TtlLruCache<string, AuditResult>;
  private readonly semaphore: Semaphore;
  private readonly inFlight = new Map<string, Promise<AuditResult>>();
  private readonly fetchImpl: FetchLike;
  private readonly dnsLookup?: DnsLookup;
  private readonly now: () => number;

  constructor(
    private readonly config: AuditServiceConfig,
    options: { fetchImpl?: FetchLike; dnsLookup?: DnsLookup; now?: () => number } = {},
  ) {
    this.cache = new TtlLruCache(config.cacheTtlMs, config.cacheMaxEntries, options.now);
    this.semaphore = new Semaphore(config.auditConcurrency, config.auditQueueLimit);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dnsLookup = options.dnsLookup;
    this.now = options.now ?? Date.now;
  }

  async audit(input: string): Promise<AuditResponse> {
    const url = normalizeAuditUrl(input);
    const cached = this.cache.get(url);
    if (cached) return { result: cached, cache: "hit" };

    let pending = this.inFlight.get(url);
    const cache = "miss" as const;
    if (!pending) {
      pending = this.semaphore.run(() => this.fetchAudit(url)).then((result) => {
        this.cache.set(url, result);
        return result;
      });
      this.inFlight.set(url, pending);
      void pending.finally(() => this.inFlight.delete(url)).catch(() => undefined);
    }

    return { result: await pending, cache };
  }

  getStats() {
    return { cacheEntries: this.cache.size, inFlight: this.inFlight.size, concurrency: this.semaphore.stats };
  }

  private async fetchAudit(initialUrl: string): Promise<AuditResult> {
    const startedAt = performance.now();
    const deadline = startedAt + this.config.requestTimeoutMs;
    const redirects: string[] = [];
    let currentUrl = initialUrl;

    for (let redirectCount = 0; redirectCount <= this.config.maxRedirects; redirectCount += 1) {
      const parsedUrl = new URL(currentUrl);
      await assertPublicHostname(parsedUrl.hostname, this.dnsLookup);
      const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const response = await this.fetchWithTimeout(currentUrl, remainingMs);
      const location = response.headers.get("location");

      if (response.status >= 300 && response.status < 400 && location) {
        if (redirectCount >= this.config.maxRedirects) {
          await response.body?.cancel().catch(() => undefined);
          throw new AppError(502, "TOO_MANY_REDIRECTS", "The target URL exceeded the redirect limit.");
        }
        const nextUrl = normalizeAuditUrl(new URL(location, currentUrl).href);
        redirects.push(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      const contentType = response.headers.get("content-type");
      const body = await this.readResponseBody(response, deadline);
      const isHtml = contentType?.toLowerCase().includes("text/html") ?? false;

      return {
        url: currentUrl,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        responseTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        contentType,
        contentLengthBytes: body.bytes,
        title: isHtml ? extractTitle(body.text) : null,
        redirects,
        checkedAt: new Date(this.now()).toISOString(),
      };
    }

    throw new AppError(502, "TOO_MANY_REDIRECTS", "The target URL exceeded the redirect limit.");
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1",
          "user-agent": "PagePulse/1.0 (+https://digitalheroesco.com)",
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError(504, "UPSTREAM_TIMEOUT", "The target URL did not respond within the timeout.");
      }
      throw new AppError(502, "UPSTREAM_REQUEST_FAILED", "The target URL could not be fetched.", {
        details: { reason: error instanceof Error ? error.message : "unknown error" },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readResponseBody(response: Response, deadline: number) {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      return await readBody(response, this.config.maxResponseBytes, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
        throw new AppError(504, "UPSTREAM_TIMEOUT", "The target URL did not respond within the timeout.");
      }
      throw new AppError(502, "UPSTREAM_RESPONSE_FAILED", "The target response could not be read.");
    } finally {
      clearTimeout(timer);
    }
  }
}
