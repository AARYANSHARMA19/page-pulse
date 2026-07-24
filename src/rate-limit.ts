import { AppError } from "./errors.js";

type Bucket = { timestamps: number[] };

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), windowMs);
    this.cleanupTimer.unref();
  }

  check(clientKey: string): RateLimitResult {
    const current = this.now();
    const bucket = this.buckets.get(clientKey) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > current - this.windowMs);
    const resetAt = (bucket.timestamps[0] ?? current) + this.windowMs;
    const allowed = bucket.timestamps.length < this.limit;
    if (allowed) bucket.timestamps.push(current);
    this.buckets.set(clientKey, bucket);

    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.timestamps.length),
      resetAt,
    };
  }

  assertAllowed(clientKey: string): RateLimitResult {
    const result = this.check(clientKey);
    if (!result.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many audit requests. Please retry later.", {
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - this.now()) / 1000)),
      });
    }
    return result;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanup(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > cutoff);
      if (bucket.timestamps.length === 0) this.buckets.delete(key);
    }
  }
}
