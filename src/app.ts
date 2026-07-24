import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { AuditService } from "./audit-service.js";
import { Config, loadConfig } from "./config.js";
import { AppError, errorResponse } from "./errors.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { normalizeAuditUrl } from "./url.js";

const auditRequestSchema = z.object({
  url: z.string().trim().min(1, "url is required").max(2048, "url must be 2048 characters or fewer"),
}).strict();

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const compiledPublicDirectory = path.join(currentDirectory, "../public");
const publicDirectory = existsSync(compiledPublicDirectory) ? compiledPublicDirectory : path.join(process.cwd(), "public");

export type AppDependencies = {
  config?: Config;
  auditService?: AuditService;
  rateLimiter?: SlidingWindowRateLimiter;
};

function applyRateHeaders(reply: { header: (name: string, value: string | number) => unknown }, result: { limit: number; remaining: number; resetAt: number }) {
  reply.header("x-ratelimit-limit", result.limit);
  reply.header("x-ratelimit-remaining", result.remaining);
  reply.header("x-ratelimit-reset", Math.ceil(result.resetAt / 1000));
}

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const config = dependencies.config ?? loadConfig();
  const auditService = dependencies.auditService ?? new AuditService({
    requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
    maxRedirects: config.MAX_REDIRECTS,
    maxResponseBytes: config.MAX_RESPONSE_BYTES,
    auditConcurrency: config.AUDIT_CONCURRENCY,
    auditQueueLimit: config.AUDIT_QUEUE_LIMIT,
    cacheTtlMs: config.CACHE_TTL_MS,
    cacheMaxEntries: config.CACHE_MAX_ENTRIES,
  });
  const rateLimiter = dependencies.rateLimiter ?? new SlidingWindowRateLimiter(config.RATE_LIMIT_MAX, config.RATE_LIMIT_WINDOW_MS);

  const app = fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY_HOPS,
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    },
  });

  app.register(fastifyStatic, { root: publicDirectory, wildcard: false, index: false });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

  app.get("/healthz", async (_request, reply) => reply.send({ status: "ok", service: "page-pulse" }));

  app.get("/readyz", async (_request, reply) => {
    const stats = auditService.getStats();
    return reply.send({ status: "ready", service: "page-pulse", capacity: stats.concurrency });
  });

  const handleAudit = async (request: FastifyRequest, reply: FastifyReply) => {
    const rate = rateLimiter.check(request.ip);
    applyRateHeaders(reply, rate);
    if (!rate.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many audit requests. Please retry later.", {
        retryAfterSeconds: Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000)),
      });
    }

    const parsed = auditRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "INVALID_REQUEST", "Request body must contain exactly one valid url field.", {
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
      });
    }

    const normalizedUrl = normalizeAuditUrl(parsed.data.url);
    request.log.info({ event: "audit_requested", host: new URL(normalizedUrl).hostname }, "audit requested");
    const response = await auditService.audit(normalizedUrl);
    request.log.info({ event: "audit_completed", cache: response.cache, status: response.result.status }, "audit completed");
    return reply.send({ data: response.result, meta: { cache: response.cache, requestId: request.id } });
  };

  app.post("/api/audit", handleAudit);
  app.post("/audit", handleAudit);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found." }, requestId: request.id });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SyntaxError && "statusCode" in error) {
      const response = errorResponse(new AppError(400, "INVALID_JSON", "Request body contains invalid JSON."), request.id);
      return reply.code(response.statusCode).send(response.body);
    }

    const response = errorResponse(error, request.id);
    if (response.retryAfterSeconds) reply.header("retry-after", response.retryAfterSeconds);
    if (response.statusCode >= 500) {
      request.log.error({ err: error, event: "request_failed" }, "request failed");
    } else {
      request.log.warn({ event: "request_rejected", code: response.body.error.code }, "request rejected");
    }
    return reply.code(response.statusCode).send(response.body);
  });

  app.addHook("onClose", async () => rateLimiter.close());
  return app;
}

// Vercel's Fastify detector can use this module directly. The explicit api/index.ts
// adapter is kept as the stable route, while this lazy handler makes auto-detection
// safe without creating a second app during local startup.
let vercelApp: FastifyInstance | undefined;
let vercelReady: Promise<void> | undefined;

export default async function vercelHandler(request: IncomingMessage, response: ServerResponse) {
  vercelApp ??= buildApp();
  vercelReady ??= Promise.resolve().then(() => vercelApp!.ready()).then(() => undefined);
  await vercelReady;
  vercelApp.server.emit("request", request, response);
}
