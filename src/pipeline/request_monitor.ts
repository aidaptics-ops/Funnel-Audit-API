import type { Page } from "playwright";

export interface ConsoleErrorRecord {
  text: string;
  source: string | null;
}

export interface FailedRequestRecord {
  url: string;
  status: number | null;
  reason: string;
  /** How often this url+status failed; a retry loop folds into one entry. */
  occurrences: number;
}

/**
 * Ceiling on every retained array. A page with a retry loop, or a script that
 * throws inside requestAnimationFrame, emits these by the thousand; the payload
 * only ever reports the first few dozen, so keeping more costs memory for the
 * lifetime of the analysis and buys nothing. The true counts are kept
 * separately so the caller can still report a real number.
 */
const MAX_ENTRIES = 200;

/** Third-party beacons fail constantly and say nothing about the page. */
function isNoise(url: string): boolean {
  return /google-analytics\.com|googletagmanager\.com\/gtag|facebook\.com\/tr|doubleclick\.net|hotjar\.com|clarity\.ms|segment\.io|sentry\.io|youtube\.com\/(?:api\/stats|youtubei)|googlevideo\.com|\.gif\?|favicon\.(?:ico|png)/i.test(
    url,
  );
}

function isConsoleNoise(text: string): boolean {
  return /third-party cookie|will be blocked|deprecat|ERR_BLOCKED_BY_CLIENT|preload/i.test(text);
}

/** Records console errors and failed requests for the technical section. */
export class RequestMonitor {
  readonly consoleErrors: ConsoleErrorRecord[] = [];
  readonly pageErrors: string[] = [];
  readonly failedRequests: FailedRequestRecord[] = [];
  /** url+status to the retained entry, so repeats increment instead of appending. */
  private readonly failedByKey = new Map<string, FailedRequestRecord>();
  private requests = 0;
  private failedTotal = 0;
  private consoleTotal = 0;
  private pageErrorsTotal = 0;

  attach(page: Page): void {
    page.on("request", () => {
      this.requests += 1;
    });

    page.on("response", (response) => {
      const status = response.status();
      const url = response.url();
      if (status >= 400 && !isNoise(url)) {
        this.recordFailure(url, status, `HTTP ${status} ${response.statusText()}`.trim());
      }
    });

    page.on("requestfailed", (request) => {
      const url = request.url();
      const reason = request.failure()?.errorText || "request failed";
      // ERR_ABORTED nearly always means the page navigated away.
      if (isNoise(url) || /ERR_ABORTED/i.test(reason)) return;
      this.recordFailure(url, null, reason);
    });

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const source = message.location()?.url || null;
      if (!text || isConsoleNoise(text) || (source && isNoise(source))) return;
      this.consoleTotal += 1;
      if (this.consoleErrors.length >= MAX_ENTRIES) return;
      this.consoleErrors.push({ text: text.slice(0, 500), source: source ? trim(source) : null });
    });

    page.on("pageerror", (error) => {
      this.pageErrorsTotal += 1;
      if (this.pageErrors.length >= MAX_ENTRIES) return;
      this.pageErrors.push(String(error.message || error).slice(0, 500));
    });
  }

  private recordFailure(url: string, status: number | null, reason: string): void {
    this.failedTotal += 1;
    const trimmed = trim(url);
    const key = `${trimmed}\u0000${status ?? "none"}`;
    const existing = this.failedByKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    if (this.failedRequests.length >= MAX_ENTRIES) return;
    const record: FailedRequestRecord = { url: trimmed, status, reason, occurrences: 1 };
    this.failedByKey.set(key, record);
    this.failedRequests.push(record);
  }

  get requestCount(): number {
    return this.requests;
  }

  /** Every failure seen, before deduplication and the retention cap. */
  get failedRequestTotal(): number {
    return this.failedTotal;
  }

  get consoleErrorTotal(): number {
    return this.consoleTotal;
  }

  get pageErrorTotal(): number {
    return this.pageErrorsTotal;
  }
}

function trim(url: string): string {
  return url.length > 300 ? `${url.slice(0, 300)}…` : url;
}
