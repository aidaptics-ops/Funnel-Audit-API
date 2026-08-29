export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

interface Waiter {
  settled: boolean;
  timer: NodeJS.Timeout | null;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

/**
 * A fair (FIFO) counting semaphore. One analysis holds one permit for as long
 * as it owns a browser context, which is what keeps a small Render instance
 * from opening more pages than its memory allows.
 */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(limit: number) {
    this.#limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get limit(): number {
    return this.#limit;
  }

  /**
   * Resolves with a release function once a permit is free. When timeoutMs is
   * given and the wait exceeds it, the promise rejects with a TimeoutError and
   * the waiter is dropped from the queue.
   */
  acquire(timeoutMs?: number): Promise<() => void> {
    // Jumping an occupied queue would starve earlier callers, so the fast path
    // requires both a free permit and an empty queue.
    if (this.#active < this.#limit && this.#queue.length === 0) {
      this.#active += 1;
      return Promise.resolve(this.#makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { settled: false, timer: null, resolve, reject };

      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(new TimeoutError(`Timed out after ${timeoutMs}ms waiting for a free slot`));
        }, timeoutMs);
      }

      this.#queue.push(waiter);
    });
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // releasing twice must not hand out a phantom permit
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#active += 1;
      waiter.resolve(this.#makeRelease());
    }
  }
}

/**
 * Rejects with a TimeoutError after ms unless the promise settles first. The
 * timer is always cleared, so a fast promise never holds the event loop open.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });

  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
