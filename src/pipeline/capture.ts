import type { Browser, BrowserContext, Page, Response } from "playwright";
import { createContext } from "../browser/context_manager.js";
import { extractPageEvidence } from "../extraction/index.js";
import { logger } from "../logging/logger.js";
import type { BrowserConfig, DomSnapshot, PageRecord } from "../types/index.js";
import type { LinkCheckResult, RedirectHop } from "../analysis/landing_types.js";
import { RequestMonitor, type ConsoleErrorRecord, type FailedRequestRecord } from "./request_monitor.js";
import {
  waitForPageStable,
  dismissObstructions,
  isBrowserErrorUrl,
  isSameDocument,
} from "./page_stability.js";
import { checkLinks, type LinkCheckOptions } from "./link_checker.js";

export interface CaptureOptions {
  jobId: string;
  url: string;
  browser: Browser;
  config: BrowserConfig;
  /** Second, mobile-viewport pass. Costs another page load. */
  checkMobileViewport: boolean;
  linkCheck: LinkCheckOptions;
  /**
   * The SSRF guard, injected rather than imported so the pipeline never reads
   * deployment configuration. It is applied to every main-frame navigation, so
   * a redirect into a private address is refused before the browser fetches it.
   */
  isAllowedUrl: (url: string) => boolean;
  /** Hard ceiling for the whole capture. Defaults to 3x the navigation timeout. */
  deadlineMs?: number;
}

export interface MobileObservation {
  tested: boolean;
  viewport_width: number | null;
  horizontal_overflow: boolean | null;
  viewport_meta_present: boolean;
  note: string | null;
}

export interface CaptureResult {
  requested_url: string;
  final_url: string;
  http_status: number | null;
  status_text: string | null;
  content_type: string | null;
  redirect_chain: RedirectHop[];
  snapshot: DomSnapshot;
  record: PageRecord;
  console_errors: ConsoleErrorRecord[];
  page_errors: string[];
  failed_requests: FailedRequestRecord[];
  /** Everything observed, including the entries dropped by the monitor's cap. */
  failed_request_total: number;
  console_error_total: number;
  request_count: number;
  stability_events: string[];
  timing: { navigation_ms: number; render_wait_ms: number; total_ms: number };
  mobile: MobileObservation;
  link_checks: LinkCheckResult[];
  link_check_summary: { checked: number; skipped: number; note: string };
}

/**
 * Loads one landing page and gathers every observable fact. It never clicks,
 * fills or submits anything on the page.
 *
 * The whole body runs under a hard deadline: a page that hangs inside an
 * evaluate would otherwise keep the context, page and monitor alive for the
 * lifetime of the process, long after the API gave up on the request.
 */
export async function captureLandingPage(options: CaptureOptions): Promise<CaptureResult> {
  const startedAt = Date.now();
  const deadlineMs = options.deadlineMs ?? options.config.navigation_timeout_ms * 3;
  const deadlineAt = startedAt + deadlineMs;

  // Every context this capture opens, so the deadline path can close the mobile
  // one too instead of leaking it.
  const contexts: BrowserContext[] = [];
  const context = await createContext(options.browser, options.config, { device: "desktop" });
  contexts.push(context);

  try {
    return await withDeadline(
      runCapture(context, contexts, options, startedAt, deadlineAt),
      deadlineMs,
      "The capture",
    );
  } finally {
    // Closing the contexts rejects whatever an abandoned capture still awaits.
    await Promise.all(contexts.map((open) => open.close().catch(() => undefined)));
  }
}

async function runCapture(
  context: BrowserContext,
  contexts: BrowserContext[],
  options: CaptureOptions,
  startedAt: number,
  deadlineAt: number,
): Promise<CaptureResult> {
  const monitor = new RequestMonitor();

  const page = await context.newPage();
  monitor.attach(page);
  const guard = await installNavigationGuard(context, page, options.isAllowedUrl);

  const navigationStart = Date.now();
  let response: Response | null = null;
  try {
    response = await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: options.config.navigation_timeout_ms,
    });
  } catch (error) {
    // A refused hop aborts the navigation, so the blocked address - not the
    // generic abort message Chromium reports - is what actually happened.
    if (guard.blockedUrl !== null) {
      throw new BlockedNavigationError(
        `Navigation to a disallowed address was refused: ${describeUrl(guard.blockedUrl)}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new NavigationError(message);
  }
  const navigationMs = Date.now() - navigationStart;

  assertNavigationAllowed(page.url(), options.isAllowedUrl);

  const renderStart = Date.now();
  const stabilityEvents = await waitForPageStable(page, options.config.timeout_ms).catch(() => [
    "stability_wait_failed",
  ]);

  // Cookie banners cover the page and hide the content being analysed.
  const beforeDismissal = page.url();
  const dismissed = await dismissObstructions(page).catch(() => []);
  if (dismissed.length) {
    await waitForPageStable(page, 5000).catch(() => []);
    stabilityEvents.push(`dismissed:${dismissed.length}`);
  }
  // A "dismiss" control can be a link. If it navigated, everything below
  // describes a different document and the payload has to say so.
  const afterDismissal = page.url();
  if (!isSameDocument(beforeDismissal, afterDismissal)) {
    stabilityEvents.push(`page_navigated_during_dismissal:${describeUrl(afterDismissal)}`);
  }

  await settleLazyContent(page, budget(deadlineAt, 5000));
  const renderWaitMs = Date.now() - renderStart;

  if (guard.blockedUrl !== null) {
    stabilityEvents.push(`blocked_navigation:${describeUrl(guard.blockedUrl)}`);
  }
  // Re-checked after the render phase: a meta refresh or a scripted redirect
  // could have moved the document since the load completed.
  assertNavigationAllowed(page.url(), options.isAllowedUrl);

  const extracted = await withDeadline(
    extractPageEvidence(page),
    budget(deadlineAt, options.config.timeout_ms * 2),
    "Page extraction",
  );


  const links = await checkLinks(context, extracted.snapshot, options.linkCheck);

  const finalUrl = page.url();
  const responseUrl = response?.url() ?? null;
  // goto resolves on the first document; a client-side hop (meta refresh,
  // location.replace) after that leaves the response describing a page nobody
  // analysed. Reporting its status would attribute it to the wrong document.
  const responseDescribesPage = responseUrl !== null && isSameDocument(responseUrl, finalUrl);
  const redirects = await redirectChain(response);
  if (responseUrl !== null && !responseDescribesPage) {
    redirects.push({ url: finalUrl, status: null });
  }

  const result: CaptureResult = {
    requested_url: options.url,
    final_url: finalUrl,
    http_status: responseDescribesPage ? response?.status() ?? null : null,
    status_text: responseDescribesPage ? response?.statusText() ?? null : null,
    content_type: responseDescribesPage ? response?.headers()["content-type"] ?? null : null,
    redirect_chain: redirects,
    snapshot: extracted.snapshot,
    record: extracted.record,
    console_errors: monitor.consoleErrors,
    page_errors: monitor.pageErrors,
    failed_requests: monitor.failedRequests,
    failed_request_total: monitor.failedRequestTotal,
    console_error_total: monitor.consoleErrorTotal,
    request_count: monitor.requestCount,
    stability_events: stabilityEvents,
    timing: { navigation_ms: navigationMs, render_wait_ms: renderWaitMs, total_ms: 0 },
    mobile: { tested: false, viewport_width: null, horizontal_overflow: null, viewport_meta_present: false, note: null },
    link_checks: links.results,
    link_check_summary: links.summary,
  };

  if (options.checkMobileViewport) {
    result.mobile = await observeMobileViewport(options, contexts, deadlineAt);
  }

  result.timing.total_ms = Date.now() - startedAt;
  return result;
}

export class NavigationError extends Error {
  readonly code = "navigation_failed";
}

/** The page reached for an address the SSRF guard refuses. No content is returned. */
export class BlockedNavigationError extends Error {
  readonly code = "blocked_navigation";
}

/** The capture ran past its hard deadline and was abandoned. */
export class CaptureTimeoutError extends Error {
  readonly code = "analysis_timeout";
}

/* ---------------------------- navigation guard ---------------------------- */

interface NavigationGuard {
  blockedUrl: string | null;
}

/**
 * Second layer of the SSRF control. The submitted URL is validated once by the
 * caller, but Chromium follows redirects on its own, so without this a public
 * URL that 302s to 169.254.169.254 would be fetched and its rendered text and
 * content handed back. Only main-frame document requests are judged: those
 * are the ones whose content leaves the service. Subresources are let through
 * because blocking them would change how the page renders.
 */
async function installNavigationGuard(
  context: BrowserContext,
  page: Page,
  isAllowed: (url: string) => boolean,
): Promise<NavigationGuard> {
  const guard: NavigationGuard = { blockedUrl: null };
  const mainFrame = page.mainFrame();

  await context.route("**/*", async (route) => {
    const request = route.request();
    let judge = false;
    if (request.isNavigationRequest()) {
      try {
        judge = request.frame() === mainFrame;
      } catch {
        // frame() throws when the navigation predates its frame. Which frame it
        // belongs to is then unknown, so the guard is applied rather than skipped.
        judge = true;
      }
    }

    if (judge && !isAllowed(request.url())) {
      guard.blockedUrl = request.url();
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });

  return guard;
}

/**
 * Last line of defence: whatever the routing did, the document that ends up in
 * the payload must itself pass the guard.
 */
function assertNavigationAllowed(current: string, isAllowed: (url: string) => boolean): void {
  // A browser error page carries no content from the target, and is reported
  // through the navigation-failure path instead.
  if (isBrowserErrorUrl(current)) return;
  if (!isAllowed(current)) {
    throw new BlockedNavigationError(`The page resolved to a disallowed address: ${describeUrl(current)}`);
  }
}

/* --------------------------------- timing --------------------------------- */

/** Milliseconds left before the capture deadline, never less than one second. */
function budget(deadlineAt: number, preferredMs: number): number {
  return Math.max(1000, Math.min(preferredMs, deadlineAt - Date.now()));
}

/**
 * Rejects with CaptureTimeoutError when `work` outlives its budget. The
 * abandoned work is left to fail on its own once the context closes; that
 * failure is already reported through this race, so it is silenced here rather
 * than surfacing as an unhandled rejection.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CaptureTimeoutError(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * page.evaluate carries no timeout of its own, so a script that never settles
 * would hang the capture. This returns null instead of stalling; the abandoned
 * evaluate is rejected when the context closes.
 */
async function evaluateWithTimeout<T>(page: Page, script: string, timeoutMs: number): Promise<T | null> {
  const work: Promise<T | null> = page
    .evaluate(script)
    .then((value) => value as T)
    .catch(() => null);
  return withDeadline(work, timeoutMs, "Page evaluate").catch(() => null);
}

/* --------------------------------- capture -------------------------------- */

/** Scrolls once to trigger lazy-loaded media, then returns to the top. */
async function settleLazyContent(page: Page, timeoutMs: number): Promise<void> {
  await evaluateWithTimeout(
    page,
    `(() => {
      const height = document.documentElement.scrollHeight;
      window.scrollTo(0, Math.min(height, window.innerHeight * 2));
      window.scrollTo(0, 0);
      return true;
    })()`,
    timeoutMs,
  );
  await page.waitForTimeout(250).catch(() => undefined);
}

/**
 * A second, throwaway mobile context. Only facts that genuinely need a mobile
 * viewport are read here; everything else comes from the desktop pass. Nothing
 * in here may propagate: a mobile failure must not destroy an otherwise
 * complete analysis, so it is reported as an untested mobile pass instead.
 */
async function observeMobileViewport(
  options: CaptureOptions,
  contexts: BrowserContext[],
  deadlineAt: number,
): Promise<MobileObservation> {
  let context: BrowserContext | null = null;
  try {
    context = await createContext(options.browser, options.config, { device: "mobile" });
    // Registered before use so the deadline path closes it even if this pass hangs.
    contexts.push(context);

    const page = await context.newPage();
    const guard = await installNavigationGuard(context, page, options.isAllowedUrl);
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: options.config.navigation_timeout_ms,
    });
    if (guard.blockedUrl !== null) {
      throw new BlockedNavigationError(
        `Navigation to a disallowed address was refused: ${describeUrl(guard.blockedUrl)}`,
      );
    }
    assertNavigationAllowed(page.url(), options.isAllowedUrl);

    await waitForPageStable(page, Math.min(options.config.timeout_ms, 15000)).catch(() => []);
    await dismissObstructions(page).catch(() => []);

    const observed = await evaluateWithTimeout<{
      viewport_width: number;
      horizontal_overflow: boolean;
      viewport_meta_present: boolean;
    }>(
      page,
      `(() => ({
        viewport_width: window.innerWidth,
        horizontal_overflow: document.documentElement.scrollWidth > window.innerWidth + 8,
        viewport_meta_present: Boolean(document.querySelector('meta[name="viewport"]')),
      }))()`,
      budget(deadlineAt, 5000),
    );

    return {
      tested: true,
      viewport_width: observed?.viewport_width ?? null,
      horizontal_overflow: observed?.horizontal_overflow ?? null,
      viewport_meta_present: Boolean(observed?.viewport_meta_present),
      note: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Mobile viewport check skipped: ${message}`);
    return {
      tested: false,
      viewport_width: null,
      horizontal_overflow: null,
      viewport_meta_present: false,
      note: `Mobile pass did not complete: ${message}`,
    };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

async function redirectChain(response: Response | null): Promise<RedirectHop[]> {
  const hops: RedirectHop[] = [];
  let request = response?.request() ?? null;
  const seen = new Set<string>();

  while (request) {
    const previous = request.redirectedFrom();
    if (!previous) break;
    const url = previous.url();
    if (seen.has(url)) break;
    seen.add(url);
    const previousResponse = await previous.response();
    hops.unshift({ url, status: previousResponse?.status() ?? null });
    request = previous;
  }

  if (response) hops.push({ url: response.url(), status: response.status() });
  return hops;
}

/** Origin and path only: query strings routinely carry ids and tokens. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}
