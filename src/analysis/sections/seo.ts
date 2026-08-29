import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, MetaRecord } from "../../types/index.js";
import type { SeoSection } from "../landing_types.js";

const MAX_MISSING_ALT_EXAMPLES = 5;
const EXAMPLE_LIMIT = 160;

const OG_FIELDS: { key: string; field: keyof MetaRecord }[] = [
  { key: "og:title", field: "og_title" },
  { key: "og:description", field: "og_description" },
  { key: "og:image", field: "og_image" },
  { key: "og:type", field: "og_type" },
  { key: "og:site_name", field: "og_site_name" },
  { key: "og:url", field: "og_url" },
];

const TWITTER_FIELDS: { key: string; field: keyof MetaRecord }[] = [
  { key: "twitter:card", field: "twitter_card" },
  { key: "twitter:title", field: "twitter_title" },
  { key: "twitter:description", field: "twitter_description" },
  { key: "twitter:image", field: "twitter_image" },
];

export function buildSeo(capture: CaptureResult): SeoSection {
  const snapshot = capture.snapshot;
  const meta = snapshot.meta;

  const title = emptyToNull(snapshot.title);
  const description = emptyToNull(meta.description);
  const canonical = emptyToNull(meta.canonical);
  const robots = emptyToNull(meta.robots);

  const h1s = snapshot.headings.filter((heading) => heading.level === 1);
  const levels = snapshot.headings.map((heading) => heading.level);
  const visibleHeadings = snapshot.headings.filter((heading) => heading.visible && heading.text.trim());
  const visibleLevels = visibleHeadings.map((heading) => heading.level);
  const visibleH1s = visibleHeadings.filter((heading) => heading.level === 1);
  const structured = collectStructuredData(snapshot.json_ld);
  const missingAlt = snapshot.images.filter((image) => image.visible && !emptyToNull(image.alt));

  return {
    title: { text: title, length: title ? title.length : 0, present: title !== null },
    meta_description: {
      text: description,
      length: description ? description.length : 0,
      present: description !== null,
    },
    canonical: {
      url: canonical,
      present: canonical !== null,
      self_referential: canonical === null ? null : isSelfReferential(canonical, capture.final_url),
    },
    robots: { content: robots, indexable: indexable(robots) },
    h1: {
      count: h1s.length,
      texts: h1s.map((heading) => heading.text.trim()).filter(Boolean),
      visible_count: visibleH1s.length,
      visible_texts: visibleH1s.map((heading) => heading.text.trim()).filter(Boolean),
    },
    heading_structure: {
      order: levels,
      skipped_levels: skippedLevels(levels),
      starts_with_h1: levels.length > 0 && levels[0] === 1,
      // A hidden template or legal heading is in the DOM but is not part of the
      // document a visitor reads, so the audit reasons about these instead.
      visible_order: visibleLevels,
      visible_skipped_levels: skippedLevels(visibleLevels),
      visible_starts_with_h1: visibleLevels.length > 0 && visibleLevels[0] === 1,
      dom_heading_count: snapshot.headings.length,
      visible_heading_count: visibleHeadings.length,
    },
    open_graph: presentMeta(meta, OG_FIELDS),
    twitter: presentMeta(meta, TWITTER_FIELDS),
    structured_data: {
      types: structured.types,
      count: snapshot.json_ld.length,
      parse_errors: structured.parseErrors,
    },
    images: {
      total: snapshot.images.length,
      missing_alt: missingAlt.length,
      missing_alt_examples: missingAlt
        .slice(0, MAX_MISSING_ALT_EXAMPLES)
        .map((image) => shorten(image.src ?? "(image with no src)")),
    },
    language: snapshot.lang ?? null,
    viewport_meta: viewportMeta(snapshot),
  };
}

/**
 * Absent robots tag says nothing either way, so indexability stays null rather
 * than defaulting to indexable.
 */
function indexable(robots: string | null): boolean | null {
  if (robots === null) return null;
  return !/\bnoindex\b/i.test(robots);
}

function isSelfReferential(canonical: string, finalUrl: string): boolean | null {
  const left = normaliseUrl(canonical, finalUrl);
  const right = normaliseUrl(finalUrl, finalUrl);
  if (left === null || right === null) return null;
  return left === right;
}

/** Compares scheme, host, path and query; the fragment is not part of identity. */
function normaliseUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return null;
  }
}

/** h2 followed by h4 means level 3 was jumped over. */
function skippedLevels(levels: number[]): number[] {
  const skipped = new Set<number>();
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1];
    const current = levels[index];
    for (let level = previous + 1; level < current; level += 1) skipped.add(level);
  }
  return [...skipped].sort((a, b) => a - b);
}

function presentMeta(
  meta: MetaRecord,
  fields: { key: string; field: keyof MetaRecord }[],
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const { key, field } of fields) {
    const raw = meta[field];
    const value = typeof raw === "string" ? emptyToNull(raw) : null;
    if (value !== null) values[key] = value;
  }
  return values;
}

interface StructuredData {
  types: string[];
  parseErrors: number;
}

function collectStructuredData(entries: unknown[]): StructuredData {
  const types: string[] = [];
  const seen = new Set<string>();
  let parseErrors = 0;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    // The snapshot records unparseable ld+json blocks as { parse_error: true }.
    if (object.parse_error === true) {
      parseErrors += 1;
      return;
    }
    const type = object["@type"];
    for (const value of Array.isArray(type) ? type : [type]) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      types.push(trimmed);
    }
    for (const value of Object.values(object)) walk(value);
  };

  walk(entries);
  return { types, parseErrors };
}

/**
 * The snapshot records only whether the viewport tag exists, not its content,
 * so presence is reported rather than an invented content string.
 */
function viewportMeta(snapshot: DomSnapshot): string | null {
  const captured = (snapshot.meta as MetaRecord & { viewport?: string | null }).viewport;
  if (typeof captured === "string" && captured.trim()) return captured.trim();
  return snapshot.has_viewport_meta ? "present" : null;
}

function shorten(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > EXAMPLE_LIMIT ? `${collapsed.slice(0, EXAMPLE_LIMIT - 1)}…` : collapsed;
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}
