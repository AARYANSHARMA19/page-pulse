import { z } from "zod";

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: integer(3000, 1, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY_HOPS: integer(0, 0, 10),
  REQUEST_TIMEOUT_MS: integer(5000, 100, 30000),
  MAX_REDIRECTS: integer(5, 0, 10),
  MAX_RESPONSE_BYTES: integer(1_000_000, 1024, 10_000_000),
  AUDIT_CONCURRENCY: integer(32, 1, 1000),
  AUDIT_QUEUE_LIMIT: integer(128, 0, 10000),
  CACHE_TTL_MS: integer(60_000, 0, 86_400_000),
  CACHE_MAX_ENTRIES: integer(1000, 1, 100_000),
  RATE_LIMIT_MAX: integer(60, 1, 100_000),
  RATE_LIMIT_WINDOW_MS: integer(60_000, 1000, 86_400_000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}
