import { AppError } from "./errors.js";

type Release = () => void;

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<(release: Release) => void> = [];

  constructor(private readonly limit: number, private readonly queueLimit: number) {}

  get stats() {
    return { active: this.active, queued: this.waiters.length, limit: this.limit, queueLimit: this.queueLimit };
  }

  acquire(): Promise<Release> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFactory());
    }

    if (this.waiters.length >= this.queueLimit) {
      throw new AppError(503, "AUDIT_CAPACITY", "The audit service is at capacity. Please retry shortly.", {
        retryAfterSeconds: 2,
      });
    }

    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }

  private releaseFactory(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.waiters.shift();
      if (next) {
        next(this.releaseFactory());
      } else {
        this.active -= 1;
      }
    };
  }
}
