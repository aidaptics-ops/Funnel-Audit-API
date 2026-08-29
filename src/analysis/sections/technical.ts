import { embedProvider } from "../../extraction/embed_hosts.js";
import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, MetaRecord, ScriptRecord } from "../../types/index.js";
import type { RedirectHop, TechnicalSection } from "../landing_types.js";
import { registrableHost } from "../registrable_host.js";
import { classifyParty } from "../audit/party.js";

const MAX_CONSOLE_ERRORS = 50;
const MAX_PAGE_ERRORS = 20;
const MAX_FAILED_REQUESTS = 50;

/**
 * Only facts the capture actually observed. Load times, transfer sizes and
 * performance scores are not measured by this pipeline, so they are absent
 * rather than estimated.
 */
export function buildTechnical(capture: CaptureResult): TechnicalSection {
  const snapshot = capture.snapshot;
  const technical = capture.record.technical_snapshot;
  const scripts: ScriptRecord[] = technical?.scripts ?? snapshot.scripts ?? [];

  const redirectCount = countRedirects(capture.redirect_chain);
  const viewportMetaValue = viewportMeta(snapshot);
  const hasViewportMeta =
    technical?.has_viewport_meta ?? snapshot.has_viewport_meta ?? viewportMetaValue !== null;

  const failedRequests = capture.failed_requests.slice(0, MAX_FAILED_REQUESTS).map((request) => ({
    ...classifyParty(request.url, capture.final_url),
    url: request.url,
    status: request.status,
    reason: request.reason,
  }));

  const brokenImages = (technical?.broken_images ?? snapshot.broken_images ?? []).map((image) => ({
    src: image.src ?? null,
    alt: image.alt ?? null,
  }));

  const stabilityEvents = capture.stability_events;

  return {
    https: capture.final_url.trim().toLowerCase().startsWith("https:"),
    redirected: redirectCount > 0,
    redirect_count: redirectCount,
    console_errors: capture.console_errors.slice(0, MAX_CONSOLE_ERRORS).map((entry) => ({
      ...classifyParty(entry.source, capture.final_url, entry.text),
      text: entry.text,
      source: entry.source,
    })),
    page_errors: capture.page_errors.slice(0, MAX_PAGE_ERRORS),
    failed_requests: failedRequests,
    broken_images: brokenImages,
    iframes: capture.record.iframes.map((frame) => ({
      src: frame.src ?? null,
      title: frame.title ?? null,
      provider: embedProvider(frame.src),
      visible: frame.visible,
    })),
    third_party_scripts: thirdPartyScripts(scripts, capture.final_url),
    script_count: scripts.length,
    viewport_meta: viewportMetaValue,
    horizontal_overflow: technical?.body_overflow_x ?? snapshot.body_overflow_x,
    render: {
      dom_content_loaded: stabilityEvents.includes("domcontentloaded"),
      network_idle: stabilityEvents.includes("networkidle"),
      stability_events: stabilityEvents,
    },
    resources: {
      requests: capture.request_count,
      // The true count. failed_requests above is capped for payload size, so
      // reporting its length would under-report the page's real failures.
      failed: capture.failed_requests.length,
    },
    mobile: mobile(capture, hasViewportMeta),
  };
}

/* -------------------------------- helpers -------------------------------- */

/**
 * The chain always ends with the served response, so a chain of one entry is a
 * direct load. Repeated identical URLs are not counted as separate hops.
 */
function countRedirects(chain: RedirectHop[]): number {
  const urls: string[] = [];
  for (const hop of chain) {
    const url = (hop.url || "").trim();
    if (!url) continue;
    if (urls[urls.length - 1] === url) continue;
    urls.push(url);
  }
  return Math.max(0, urls.length - 1);
}

function thirdPartyScripts(
  scripts: ScriptRecord[],
  finalUrl: string,
): { host: string; count: number }[] {
  const pageDomain = registrableHost(hostnameOf(finalUrl) ?? "");
  const counts = new Map<string, number>();

  for (const script of scripts) {
    const host = (script.host ?? "").trim().toLowerCase();
    if (!host) continue;
    if (pageDomain && registrableHost(host) === pageDomain) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The snapshot may record only whether the tag exists rather than its content,
 * so the value falls back to a presence marker instead of an invented string.
 */
function viewportMeta(snapshot: DomSnapshot): string | null {
  const captured = (snapshot.meta as MetaRecord & { viewport?: string | null }).viewport;
  if (typeof captured === "string" && captured.trim()) return captured.trim();
  return snapshot.has_viewport_meta ? "present" : null;
}

function mobile(capture: CaptureResult, hasViewportMeta: boolean): TechnicalSection["mobile"] {
  const observed = capture.mobile;
  if (observed.tested) {
    return {
      tested: true,
      viewport_meta_present: observed.viewport_meta_present,
      horizontal_overflow: observed.horizontal_overflow,
      viewport_width: observed.viewport_width,
      note: observed.note,
    };
  }

  return {
    tested: false,
    // The tag lives in the document regardless of device, so the desktop pass
    // answers this even when the mobile pass never ran.
    viewport_meta_present: hasViewportMeta,
    horizontal_overflow: null,
    viewport_width: null,
    note:
      observed.note ??
      "No mobile viewport pass was run for this analysis; mobile-only values were not measured.",
  };
}
