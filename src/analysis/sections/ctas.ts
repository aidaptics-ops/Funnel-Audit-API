import type { CaptureResult } from "../../pipeline/capture.js";
import { embedProvider, isFormEmbedSrc, schedulerProvider } from "../../extraction/embed_hosts.js";
import type { ButtonRecord, CtaRecord, DomSnapshot, LinkRecord } from "../../types/index.js";
import {
  detected,
  unknown,
  type CtaDestinationKind,
  type CtaEntry,
  type CtaType,
  type Determination,
  type LinkCheckResult,
} from "../landing_types.js";
import { registrableHost } from "../registrable_host.js";

const MAX_CTAS = 100;
const EVIDENCE_CHARS = 160;
const MAX_EVIDENCE_LABELS = 12;

/** Exact-match labels the CTA detector can let through but which are never offers. */
const NAVIGATION_LABELS = new Set([
  "home",
  "about",
  "about us",
  "about me",
  "blog",
  "articles",
  "news",
  "login",
  "log in",
  "sign in",
  "signin",
  "my account",
  "account",
  "privacy",
  "privacy policy",
  "terms",
  "terms of service",
  "terms of use",
  "terms & conditions",
  "terms and conditions",
  "disclaimer",
  "cookie policy",
  "contact",
  "contact us",
  "careers",
  "menu",
]);

const SOCIAL_LABELS = new Set([
  "facebook",
  "instagram",
  "twitter",
  "x",
  "linkedin",
  "youtube",
  "tiktok",
  "pinterest",
  "snapchat",
  "threads",
  "whatsapp",
  "telegram",
  "discord",
  "reddit",
  "github",
  "spotify",
  "vimeo",
  "medium",
  "apple podcasts",
]);

const COOKIE_LABELS = new Set([
  "accept",
  "accept all",
  "accept cookies",
  "accept all cookies",
  "allow all",
  "allow cookies",
  "allow all cookies",
  "reject",
  "reject all",
  "reject all cookies",
  "deny",
  "decline",
  "decline cookies",
  "manage cookies",
  "manage preferences",
  "cookie settings",
  "cookie preferences",
  "got it",
  "ok",
  "okay",
  "dismiss",
  "close",
]);

export function buildCtas(capture: CaptureResult): CtaEntry[] {
  const snapshot = capture.snapshot;
  const kept = capture.record.ctas.filter((cta) => !isNonCta(cta.text));
  const buttonIndex = indexButtons(snapshot.buttons);
  const linkIndex = indexLinks(snapshot.links);
  const checkIndex = indexLinkChecks(capture.link_checks);
  const navCutoffY = firstHeadingY(snapshot);

  const entries: CtaEntry[] = kept.slice(0, MAX_CTAS).map((cta, index) => {
    const button = buttonIndex.get(elementKey(cta.text, cta.href, cta.y));
    const type = ctaType(cta, button);
    return {
      index,
      text: cta.text.trim(),
      type,
      href: cta.href,
      visible: cta.visible,
      above_fold: cta.position === "above_fold",
      is_primary: false,
      form_index: null,
      is_form_submit: type === "form_submit",
      position: { x: cta.x ?? null, y: cta.y, fold: cta.position, section: cta.section },
      destination: classifyDestination(cta.href, type, capture.final_url, checkIndex),
      supporting_copy: cta.supporting_copy,
      stated_outcome: cta.stated_outcome,
    };
  });

  const primary = pickPrimary(entries, kept, linkIndex, navCutoffY);
  if (primary !== null) entries[primary]!.is_primary = true;
  return entries;
}

export function ctaConsistency(
  ctas: CtaEntry[],
): Determination<{ consistent: boolean; distinct_labels: number }> {
  const visible = ctas.filter((cta) => cta.visible);
  if (visible.length < 2) return unknown("Fewer than two CTAs were detected");

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const cta of visible) {
    const key = normaliseLabel(cta.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(cta.text.trim());
  }

  const distinctLabels = seen.size;
  const evidence = [
    `${visible.length} visible CTAs carry ${distinctLabels} distinct labels`,
    ...labels.slice(0, MAX_EVIDENCE_LABELS).map((label) => `"${trim(label)}"`),
  ];
  // Both numbers are direct counts of observed elements, so confidence only
  // reflects how much text the judgement rests on.
  const confidence = visible.length >= 3 ? 0.9 : 0.8;
  return detected({ consistent: distinctLabels <= 3, distinct_labels: distinctLabels }, confidence, evidence);
}

/* ----------------------------- classification ---------------------------- */

function ctaType(cta: CtaRecord, button: ButtonRecord | undefined): CtaType {
  if (cta.type === "input") return "form_submit";
  if (button && (button.type || "").toLowerCase() === "submit") return "form_submit";
  if (cta.type === "link") return "link";
  if (cta.type === "button") return "button";
  return "other";
}

function classifyDestination(
  href: string | null,
  type: CtaType,
  finalUrl: string,
  checks: Map<string, LinkCheckResult>,
): CtaEntry["destination"] {
  const raw = (href || "").trim();

  if (!raw) {
    return destination(type === "form_submit" ? "form_submit" : "none", null, null, null, null, checks);
  }

  if (raw === "#" || /^javascript:/i.test(raw)) {
    return destination("javascript", null, null, null, null, checks);
  }

  if (raw.startsWith("#")) {
    return destination("anchor", null, null, null, raw.slice(1) || null, checks);
  }

  if (/^mailto:/i.test(raw)) return destination("mailto", raw, null, null, null, checks);
  if (/^tel:/i.test(raw)) return destination("tel", raw, null, null, null, checks);

  let url: URL;
  try {
    url = new URL(raw, finalUrl);
  } catch {
    return destination("unknown", null, null, null, null, checks);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return destination("unknown", url.href, url.hostname || null, null, null, checks);
  }

  const host = url.hostname;
  const absolute = url.href;

  // A link back to this exact page that only moves the fragment is an anchor,
  // not a navigation away from the page.
  if (url.hash && sameDocument(url, finalUrl)) {
    return destination("anchor", absolute, host, null, url.hash.slice(1) || null, checks);
  }

  const scheduler = schedulerProvider(absolute);
  if (scheduler) return destination("scheduler", absolute, host, scheduler, null, checks);

  if (isFormEmbedSrc(absolute)) {
    return destination("form_embed", absolute, host, embedProvider(absolute), null, checks);
  }

  const internal = sameSite(host, finalUrl);
  return destination(internal ? "internal" : "external", absolute, host, null, null, checks);
}

function destination(
  kind: CtaDestinationKind,
  url: string | null,
  host: string | null,
  provider: string | null,
  anchor: string | null,
  checks: Map<string, LinkCheckResult>,
): CtaEntry["destination"] {
  const check = url ? checks.get(url) : undefined;
  return {
    kind,
    url,
    host,
    provider,
    same_page_anchor: anchor,
    resolves: check ? (check.ok ? "ok" : "broken") : "not_checked",
    status: check ? check.status : null,
  };
}

function sameDocument(url: URL, finalUrl: string): boolean {
  try {
    const base = new URL(finalUrl);
    return url.origin === base.origin && url.pathname === base.pathname && url.search === base.search;
  } catch {
    return false;
  }
}

function sameSite(host: string, finalUrl: string): boolean {
  try {
    const base = new URL(finalUrl).hostname;
    return registrableHost(host) === registrableHost(base);
  } catch {
    return false;
  }
}

/* -------------------------------- primary -------------------------------- */

const REAL_DESTINATIONS: ReadonlySet<CtaDestinationKind> = new Set<CtaDestinationKind>([
  "internal",
  "external",
  "anchor",
  "scheduler",
  "form_embed",
  "mailto",
  "tel",
  "form_submit",
]);

function pickPrimary(
  entries: CtaEntry[],
  records: CtaRecord[],
  links: Map<string, LinkRecord>,
  navCutoffY: number | null,
): number | null {
  const eligible = entries
    .map((_, i) => i)
    .filter((i) => !isChromeLink(records[i], links, navCutoffY));

  const aboveFold = eligible.find(
    (i) => entries[i]!.visible && entries[i]!.above_fold && REAL_DESTINATIONS.has(entries[i]!.destination.kind),
  );
  if (aboveFold !== undefined) return aboveFold;

  const repeated = mostRepeatedLabel(eligible, entries);
  if (repeated !== null) return repeated;

  const firstVisible = eligible.find((i) => entries[i]!.visible);
  return firstVisible ?? null;
}

function mostRepeatedLabel(eligible: number[], entries: CtaEntry[]): number | null {
  const counts = new Map<string, number>();
  for (const i of eligible) {
    const key = normaliseLabel(entries[i]!.text);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let bestKey: string | null = null;
  let bestCount = 1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (bestKey === null) return null;

  const match = eligible.find((i) => normaliseLabel(entries[i]!.text) === bestKey);
  return match ?? null;
}

/**
 * True when the CTA is really a chrome link: anything in the footer, or a link
 * sitting in the header strip above the page's first heading. Header elements
 * below the first heading are hero content, not navigation.
 */
function isChromeLink(
  record: CtaRecord | undefined,
  links: Map<string, LinkRecord>,
  navCutoffY: number | null,
): boolean {
  if (!record) return true;
  const link = links.get(elementKey(record.text, record.href, record.y));
  if (!link) return false;
  if (link.in_footer) return true;
  if (!link.in_nav) return false;
  return navCutoffY === null || record.y < navCutoffY;
}

/* -------------------------------- helpers -------------------------------- */

function isNonCta(text: string): boolean {
  const label = normaliseLabel(text);
  if (!label) return true;
  if (NAVIGATION_LABELS.has(label) || SOCIAL_LABELS.has(label) || COOKIE_LABELS.has(label)) return true;
  return MEDIA_CONTROL_LABEL.test(label);
}

/**
 * Video players expose their transport controls as buttons, and a VSL page is
 * mostly player. "Pause Video" is not an offer, and letting one through makes it
 * the primary CTA on exactly the pages where the real CTA matters most.
 */
const MEDIA_CONTROL_LABEL =
  /^(?:play|pause|stop|replay|rewind|mute|unmute|volume|fullscreen|exit fullscreen|enter fullscreen|captions?|subtitles?|settings|quality|speed|playback (?:speed|rate)|picture[- ]in[- ]picture|seek|скип|skip (?:ad|intro)|next|previous|share video|watch on youtube|copy link)\b|^(?:play|pause|stop|replay|mute|unmute|show|hide|toggle)\b.*\b(?:video|captions?|subtitles?|menu|settings|volume|sound|audio|player|transcript)\b|\b(?:captions?|subtitles?|settings) menu\b/i;

function normaliseLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

function elementKey(text: string, href: string | null, y: number): string {
  return `${normaliseLabel(text)}|${href || ""}|${y}`;
}

function indexButtons(buttons: ButtonRecord[]): Map<string, ButtonRecord> {
  const map = new Map<string, ButtonRecord>();
  for (const button of buttons) {
    const key = elementKey(button.text, button.href, button.y);
    if (!map.has(key)) map.set(key, button);
  }
  return map;
}

function indexLinks(links: LinkRecord[]): Map<string, LinkRecord> {
  const map = new Map<string, LinkRecord>();
  for (const link of links) {
    const key = elementKey(link.text, link.href, link.y);
    if (!map.has(key)) map.set(key, link);
  }
  return map;
}

function indexLinkChecks(checks: LinkCheckResult[]): Map<string, LinkCheckResult> {
  const map = new Map<string, LinkCheckResult>();
  for (const check of checks) {
    if (!map.has(check.url)) map.set(check.url, check);
  }
  return map;
}

function firstHeadingY(snapshot: DomSnapshot): number | null {
  let lowest: number | null = null;
  for (const heading of snapshot.headings) {
    if (!heading.visible) continue;
    if (lowest === null || heading.y < lowest) lowest = heading.y;
  }
  return lowest;
}

function trim(text: string, limit = EVIDENCE_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * A form and its submit button are one conversion action, not two unrelated
 * findings. Matching them lets the audit engine reason about "the form's CTA"
 * instead of treating a bare SUBMIT button as an orphan.
 *
 * Matched on submit text plus vertical proximity: the form whose fields start
 * closest above the button wins. Mutates the entries in place and returns them.
 */
export function associateCtasWithForms(ctas: CtaEntry[], forms: FormAnchor[]): CtaEntry[] {
  if (!forms.length) return ctas;

  const normalise = (value: string | null | undefined): string =>
    (value || "").toLowerCase().replace(/\s+/g, " ").trim();

  for (const cta of ctas) {
    const label = normalise(cta.text);
    const candidates = forms
      .map((form, index) => ({ form, index }))
      .filter(({ form }) => {
        if (form.cta_text && normalise(form.cta_text) === label) return true;
        // A submit control with no matching label still belongs to the form it
        // sits inside, which we approximate by "below the fields, not far".
        return cta.is_form_submit && form.y !== null && cta.position.y >= form.y;
      })
      .sort((left, right) => {
        const leftGap = left.form.y === null ? Number.MAX_SAFE_INTEGER : Math.abs(cta.position.y - left.form.y);
        const rightGap = right.form.y === null ? Number.MAX_SAFE_INTEGER : Math.abs(cta.position.y - right.form.y);
        return leftGap - rightGap;
      });

    const best = candidates[0];
    if (!best) continue;
    // Guard against pairing with a form on a completely different screen.
    const gap = best.form.y === null ? null : Math.abs(cta.position.y - best.form.y);
    if (gap !== null && gap > MAX_FORM_CTA_GAP && normalise(best.form.cta_text) !== label) continue;

    cta.form_index = best.index;
    cta.is_form_submit = true;
  }

  return ctas;
}

/** The minimum a caller must know about a form to pair it with its button. */
export interface FormAnchor {
  y: number | null;
  cta_text: string | null;
}

/** A submit button more than this far below the fields belongs to another form. */
const MAX_FORM_CTA_GAP = 1200;
