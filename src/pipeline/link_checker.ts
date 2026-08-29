import type { APIRequestContext, APIResponse, BrowserContext } from "playwright";
import type { LinkCheckResult } from "../analysis/landing_types.js";
import type { DomSnapshot } from "../types/index.js";
import { registrableHost } from "../analysis/registrable_host.js";

export interface LinkCheckOptions {
  enabled: boolean;
  maxLinks: number;
  timeoutMs: number;
  concurrency: number;
  sameOriginOnly: boolean;
  /** The SSRF guard. Every candidate is passed through it; it is never bypassed. */
  isAllowedUrl: (url: string) => boolean;
}

export interface LinkCheckReport {
  results: LinkCheckResult[];
  summary: { checked: number; skipped: number; note: string };
}

type SkipReason = "hidden" | "off_domain" | "blocked" | "over_limit";

interface Candidate {
  url: string;
  visible: boolean;
}

const DISABLED_NOTE = "Link checking is disabled.";

/** How many guard-approved redirects a single link may be followed through. */
const MAX_REDIRECT_HOPS = 3;

/**
 * The URL is there; our anonymous probe simply was not allowed to see it.
 * 999 is LinkedIn's non-standard refusal. Reporting these as broken produces a
 * critical finding on a working gated checkout, or whenever our own parallel
 * probes trip a rate limiter.
 */
const RESTRICTED_STATUSES = new Set([401, 403, 429, 999]);

/**
 * Probes the page's own outbound links with the browser context's request API.
 * It only ever issues HEAD/GET: nothing is clicked, submitted or navigated.
 */
export async function checkLinks(
  context: BrowserContext,
  snapshot: DomSnapshot,
  options: LinkCheckOptions,
): Promise<LinkCheckReport> {
  if (!options.enabled) {
    return { results: [], summary: { checked: 0, skipped: 0, note: DISABLED_NOTE } };
  }

  const candidates = collectCandidates(snapshot);
  const skipped: Record<SkipReason, number> = { hidden: 0, off_domain: 0, blocked: 0, over_limit: 0 };
  const pageHost = registrableHost(hostOf(snapshot.url) ?? "");
  const maxLinks = Math.max(0, Math.floor(options.maxLinks));
  const checkable: string[] = [];

  for (const candidate of candidates) {
    if (!candidate.visible) {
      skipped.hidden += 1;
      continue;
    }
    if (options.sameOriginOnly && registrableHost(hostOf(candidate.url) ?? "") !== pageHost) {
      skipped.off_domain += 1;
      continue;
    }
    if (!options.isAllowedUrl(candidate.url)) {
      skipped.blocked += 1;
      continue;
    }
    if (checkable.length >= maxLinks) {
      skipped.over_limit += 1;
      continue;
    }
    checkable.push(candidate.url);
  }

  const results = await probeAll(context.request, checkable, options);
  const skippedTotal = skipped.hidden + skipped.off_domain + skipped.blocked + skipped.over_limit;

  return {
    results,
    summary: {
      checked: results.length,
      skipped: skippedTotal,
      note: buildNote(results.length, skipped, options, maxLinks),
    },
  };
}

/* ------------------------------- candidates ------------------------------- */

/** Unique http(s) destinations in document order; a URL seen visible once counts as visible. */
function collectCandidates(snapshot: DomSnapshot): Candidate[] {
  const order: string[] = [];
  const seen = new Map<string, Candidate>();

  for (const link of snapshot.links) {
    const raw = (link.href || "").trim();
    if (!raw || raw.startsWith("#")) continue;

    let url: URL;
    try {
      url = new URL(raw, snapshot.url);
    } catch {
      continue;
    }
    // mailto:, tel:, javascript: and every other scheme are not requests to make.
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    // The fragment never reaches the server, so links differing only by hash
    // are the same destination.
    url.hash = "";
    const href = url.href;

    const existing = seen.get(href);
    if (existing) {
      existing.visible = existing.visible || link.visible;
      continue;
    }
    seen.set(href, { url: href, visible: link.visible });
    order.push(href);
  }

  return order.flatMap((href) => {
    const candidate = seen.get(href);
    return candidate ? [candidate] : [];
  });
}

/* --------------------------------- probing -------------------------------- */

async function probeAll(
  request: APIRequestContext,
  urls: string[],
  options: LinkCheckOptions,
): Promise<LinkCheckResult[]> {
  if (urls.length === 0) return [];

  const results: (LinkCheckResult | undefined)[] = new Array(urls.length);
  const workers = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, urls.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= urls.length) return;
      results[index] = await probe(request, urls[index] as string, options);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => run()));
  // Indexed writes keep the output in document order regardless of completion order.
  return results.filter((result): result is LinkCheckResult => result !== undefined);
}

type Attempt =
  | { ok: true; status: number; statusText: string; location: string | null; ranged: boolean }
  | { ok: false; message: string };

/**
 * Probes one link. Redirects are never followed automatically: each hop's
 * Location is re-checked against the SSRF guard, so a link on the analysed page
 * cannot steer the probe onto an internal host and turn this endpoint into a
 * port scanner. A redirect we decline to follow is still a resolved answer -
 * the link works, we just stop there.
 */
async function probe(request: APIRequestContext, url: string, options: LinkCheckOptions): Promise<LinkCheckResult> {
  let current = url;

  for (let hop = 0; ; hop += 1) {
    const attempt = await requestOnce(request, current, options.timeoutMs);
    if (!attempt.ok) return unreachable(url, current, attempt.message);

    if (attempt.status >= 300 && attempt.status < 400) {
      const target = resolveLocation(attempt.location, current);
      if (target === null) {
        return redirectResult(url, current, attempt, null, "no usable Location header was returned");
      }
      if (!options.isAllowedUrl(target)) {
        return redirectResult(url, current, attempt, target, "not followed: the target is not an allowed destination");
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        return redirectResult(url, current, attempt, target, `not followed: more than ${MAX_REDIRECT_HOPS} redirects`);
      }
      current = target;
      continue;
    }

    // Our own Range header is the only reason a 416 can appear here, so it says
    // the URL resolved, not that anything is wrong with it.
    if (attempt.status === 416 && attempt.ranged) {
      return result(url, current, 416, true, "ok", "The server rejected our range request; the URL itself resolved.");
    }

    return fromStatus(url, current, attempt.status, attempt.statusText);
  }
}

async function requestOnce(request: APIRequestContext, url: string, timeoutMs: number): Promise<Attempt> {
  try {
    const response = await request.head(url, { timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 0 });
    const status = response.status();
    // Plenty of servers answer HEAD with "method not allowed" while the page
    // itself is fine, so those two statuses are not evidence of a broken link.
    if (status === 405 || status === 501) {
      return await getOnce(request, url, timeoutMs);
    }
    return describe(response, false);
  } catch (error) {
    const message = errorMessage(error);
    // A timeout is never retried: the GET would spend the per-link budget a
    // second time and end the same way, doubling the wall clock for nothing.
    if (isTimeout(message)) return { ok: false, message };
    return await getOnce(request, url, timeoutMs);
  }
}

async function getOnce(request: APIRequestContext, url: string, timeoutMs: number): Promise<Attempt> {
  try {
    const response = await request.get(url, {
      timeout: timeoutMs,
      failOnStatusCode: false,
      maxRedirects: 0,
      // We only need the status line; asking for one byte keeps a multi-megabyte
      // page from being downloaded and buffered for every link on the page.
      headers: { Range: "bytes=0-0" },
    });
    return describe(response, true);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function describe(response: APIResponse, ranged: boolean): Attempt {
  const headers = response.headers();
  return {
    ok: true,
    status: response.status(),
    statusText: response.statusText(),
    location: headers["location"] ?? null,
    ranged,
  };
}

function resolveLocation(location: string | null, base: string): string | null {
  if (!location) return null;
  try {
    const target = new URL(location, base);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    return target.href;
  } catch {
    return null;
  }
}

function fromStatus(url: string, finalUrl: string, status: number, statusText: string): LinkCheckResult {
  const label = statusText ? `${status} ${statusText}` : `HTTP ${status}`;
  const via = finalUrl === url ? "" : ` at ${finalUrl}`;

  if (status < 400) return result(url, finalUrl, status, true, "ok", null);

  if (RESTRICTED_STATUSES.has(status)) {
    return result(
      url,
      finalUrl,
      status,
      true,
      "blocked",
      `${label}${via}: the URL exists but refused our unauthenticated probe, so this is not evidence of a broken link.`,
    );
  }

  return result(url, finalUrl, status, false, "broken", `${label}${via}`);
}

function redirectResult(
  url: string,
  from: string,
  attempt: Attempt & { ok: true },
  target: string | null,
  note: string,
): LinkCheckResult {
  const label = attempt.statusText ? `${attempt.status} ${attempt.statusText}` : `HTTP ${attempt.status}`;
  const destination = target ? ` to ${target}` : "";
  return result(url, from, attempt.status, true, "ok", `${label} redirect${destination} (${note}).`);
}

function unreachable(url: string, attempted: string, message: string): LinkCheckResult {
  const via = attempted === url ? "" : ` (while following a redirect to ${attempted})`;
  return {
    url,
    status: null,
    ok: false,
    outcome: "unreachable",
    final_url: attempted === url ? null : attempted,
    // The framing comes first so that trimming a long transport error cannot
    // cut it off: a timeout or DNS failure is our probe's result and does not
    // establish that a visitor's browser would fail too.
    reason: trim(`Our probe could not reach this URL${via} - this describes the check, not the page: ${message}`),
  };
}

function result(
  url: string,
  finalUrl: string,
  status: number | null,
  ok: boolean,
  outcome: NonNullable<LinkCheckResult["outcome"]>,
  reason: string | null,
): LinkCheckResult {
  return {
    url,
    status,
    ok,
    outcome,
    final_url: finalUrl === url ? null : finalUrl,
    reason: reason === null ? null : trim(reason),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(message: string): boolean {
  return /timeout|timed out/i.test(message);
}

/* --------------------------------- summary -------------------------------- */

function buildNote(
  checked: number,
  skipped: Record<SkipReason, number>,
  options: LinkCheckOptions,
  maxLinks: number,
): string {
  const scope = options.sameOriginOnly ? "same-origin" : "http(s)";
  const total = skipped.hidden + skipped.off_domain + skipped.blocked + skipped.over_limit;

  if (checked === 0 && total === 0) {
    return `No ${scope} links were available to check on the page.`;
  }

  const head = `Checked ${checked} ${scope} ${plural(checked, "link")}`;
  if (total === 0) return `${head}; none skipped.`;

  const parts: string[] = [];
  if (skipped.off_domain > 0) parts.push(`${skipped.off_domain} off-domain`);
  if (skipped.over_limit > 0) parts.push(`${skipped.over_limit} over the ${maxLinks}-link limit`);
  if (skipped.hidden > 0) parts.push(`${skipped.hidden} not visible`);
  if (skipped.blocked > 0) parts.push(`${skipped.blocked} blocked by the URL guard`);

  return `${head}; ${total} skipped (${parts.join(", ")}).`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/* --------------------------------- helpers -------------------------------- */

function trim(text: string, max = 160): string {
  // Playwright appends a colourised call log to request errors; only the first
  // line names the actual failure.
  const firstLine = text.split("\nCall log:")[0] ?? text;
  const collapsed = firstLine.replace(/\x1B\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

