import type { Page } from "playwright";

export interface FailedRequestRecord {
  url: string;
  status: number | null;
  reason: string;
  at: string;
}

export interface ConsoleErrorRecord {
  text: string;
  url: string;
  at: string;
}

export class NetworkCapture {
  readonly typeformPayloads: unknown[] = [];
  private readonly failures: FailedRequestRecord[] = [];
  private readonly consoleErrors: ConsoleErrorRecord[] = [];
  private readonly attached = new WeakSet<Page>();

  attach(page: Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);

    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();
      if (status >= 400 && !isNoise(url)) {
        this.failures.push({
          url: trim(url),
          status,
          reason: `HTTP ${status} ${response.statusText()}`.trim(),
          at: new Date().toISOString(),
        });
      }
      if (!/typeform\.com/i.test(url)) return;
      try {
        const text = await response.text();
        if (!/"fields"\s*:/.test(text) && !/short_text|multiple_choice|phone_number/.test(text)) return;
        const data = JSON.parse(text) as unknown;
        if (data && typeof data === "object") this.typeformPayloads.push(data);
      } catch {
        // ignore non-JSON bodies
      }
    });

    page.on("requestfailed", (request) => {
      const url = request.url();
      const reason = request.failure()?.errorText || "request failed";
      // ERR_ABORTED almost always means "the page navigated away", not a break.
      if (isNoise(url) || /ERR_ABORTED/i.test(reason)) return;
      this.failures.push({
        url: trim(url),
        status: null,
        reason,
        at: new Date().toISOString(),
      });
    });

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const source = message.location()?.url || "";
      if (!text || isConsoleNoise(text) || isNoise(source)) return;
      this.consoleErrors.push({ text: text.slice(0, 500), url: page.url(), at: new Date().toISOString() });
    });

    page.on("pageerror", (error) => {
      this.consoleErrors.push({
        text: `uncaught: ${error.message}`.slice(0, 500),
        url: page.url(),
        at: new Date().toISOString(),
      });
    });
  }

  /** Index to hand back to `since()` after the next page finishes loading. */
  mark(): { failures: number; consoleErrors: number } {
    return { failures: this.failures.length, consoleErrors: this.consoleErrors.length };
  }

  since(mark: { failures: number; consoleErrors: number }): {
    failures: FailedRequestRecord[];
    consoleErrors: ConsoleErrorRecord[];
  } {
    return {
      failures: this.failures.slice(mark.failures),
      consoleErrors: this.consoleErrors.slice(mark.consoleErrors),
    };
  }

  all(): { failures: FailedRequestRecord[]; consoleErrors: ConsoleErrorRecord[] } {
    return { failures: [...this.failures], consoleErrors: [...this.consoleErrors] };
  }
}

/** Ad/analytics beacons fail constantly and say nothing about the funnel page. */
function isNoise(url: string): boolean {
  return /google-analytics\.com|googletagmanager\.com\/gtag|facebook\.com\/tr|doubleclick\.net|hotjar\.com|clarity\.ms|segment\.io|sentry\.io|youtube\.com\/(?:api\/stats|youtubei)|googlevideo\.com|\.gif\?|favicon\.(?:ico|png)/i.test(
    url,
  );
}

function isConsoleNoise(text: string): boolean {
  return /third-party cookie|will be blocked|deprecat|Failed to load resource: net::ERR_BLOCKED_BY_CLIENT|preload/i.test(
    text,
  );
}

function trim(url: string): string {
  return url.length > 300 ? `${url.slice(0, 300)}…` : url;
}
