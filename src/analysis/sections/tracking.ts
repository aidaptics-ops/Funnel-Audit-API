import type { CaptureResult } from "../../pipeline/capture.js";
import type { ScriptRecord, TrackingSignal } from "../../types/index.js";
import type { TrackingSection, TrackingVendor } from "../landing_types.js";
import { detectTracking, thirdPartyHosts } from "../tracking_detector.js";

const EVIDENCE_LIMIT = 160;
const MAX_EVIDENCE_PER_VENDOR = 6;

interface VendorProfile {
  slug: string;
  category: TrackingVendor["category"];
}

/** Keyed by the vendor names `tracking_detector` emits. */
const VENDOR_PROFILES: Record<string, VendorProfile> = {
  "Meta Pixel": { slug: "meta_pixel", category: "advertising_pixel" },
  "Google Tag Manager": { slug: "google_tag_manager", category: "tag_manager" },
  "Google Analytics 4": { slug: "google_analytics_4", category: "analytics" },
  "Google Analytics (Universal)": { slug: "google_analytics_universal", category: "analytics" },
  "Google Ads Conversion": { slug: "google_ads", category: "advertising_pixel" },
  "TikTok Pixel": { slug: "tiktok_pixel", category: "advertising_pixel" },
  "X (Twitter) Pixel": { slug: "x_pixel", category: "advertising_pixel" },
  "Snap Pixel": { slug: "snap_pixel", category: "advertising_pixel" },
  "Pinterest Tag": { slug: "pinterest_tag", category: "advertising_pixel" },
  "LinkedIn Insight": { slug: "linkedin_insight", category: "advertising_pixel" },
  "Reddit Pixel": { slug: "reddit_pixel", category: "advertising_pixel" },
  Hotjar: { slug: "hotjar", category: "heatmap" },
  "Microsoft Clarity": { slug: "microsoft_clarity", category: "heatmap" },
  Segment: { slug: "segment", category: "analytics" },
  PostHog: { slug: "posthog", category: "analytics" },
  Mixpanel: { slug: "mixpanel", category: "analytics" },
  Amplitude: { slug: "amplitude", category: "analytics" },
  Klaviyo: { slug: "klaviyo", category: "analytics" },
  Intercom: { slug: "intercom", category: "chat" },
  Drift: { slug: "drift", category: "chat" },
  Crisp: { slug: "crisp", category: "chat" },
  Tidio: { slug: "tidio", category: "chat" },
  Hyros: { slug: "hyros", category: "attribution" },
  "Wicked Reports": { slug: "wicked_reports", category: "attribution" },
  "Triple Whale": { slug: "triple_whale", category: "attribution" },
  HubSpot: { slug: "hubspot", category: "analytics" },
};

/** Fallback for a vendor rule added to the detector without a profile here. */
const KIND_CATEGORY: Record<TrackingSignal["kind"], TrackingVendor["category"]> = {
  pixel: "advertising_pixel",
  analytics: "analytics",
  tag_manager: "tag_manager",
  chat: "chat",
  heatmap: "heatmap",
  other: "other",
};

interface IdPattern {
  slug: string;
  pattern: RegExp;
  /** The whole script src/snippet must also match, to keep loose ids anchored. */
  requires?: RegExp;
}

const ID_PATTERNS: IdPattern[] = [
  { slug: "google_tag_manager", pattern: /\bGTM-[A-Z0-9]{4,10}\b/g },
  // "G-XXXXXXXXXX" alone is too loose to trust, so it only counts inside a Google tag.
  {
    slug: "google_analytics_4",
    pattern: /\bG-[A-Z0-9]{6,12}\b/g,
    requires: /gtag|googletagmanager|google-?analytics/i,
  },
  { slug: "google_analytics_universal", pattern: /\bUA-\d{4,10}-\d{1,4}\b/g },
  { slug: "google_ads", pattern: /\bAW-\d{6,12}\b/g },
  { slug: "meta_pixel", pattern: /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/g },
  { slug: "meta_pixel", pattern: /facebook\.com\/tr\?[^"'\s]*\bid=(\d{6,20})/gi },
  { slug: "tiktok_pixel", pattern: /ttq\.load\s*\(\s*['"]([A-Za-z0-9_-]{6,40})['"]/g },
  { slug: "linkedin_insight", pattern: /_linkedin_partner_id\s*=\s*["']?(\d{3,12})/g },
  { slug: "linkedin_insight", pattern: /_linkedin_data_partner_ids\.push\s*\(\s*["']?(\d{3,12})/g },
];

interface StatementFamily {
  label: string;
  vendors: string[];
  slugs: string[];
}

const STATEMENT_FAMILIES: StatementFamily[] = [
  {
    label: "Google Analytics",
    vendors: ["Google Analytics 4", "Google Analytics (Universal)"],
    slugs: ["google_analytics_4", "google_analytics_universal"],
  },
  { label: "Google Tag Manager", vendors: ["Google Tag Manager"], slugs: ["google_tag_manager"] },
  { label: "Meta Pixel", vendors: ["Meta Pixel"], slugs: ["meta_pixel"] },
  {
    label: "Google Ads conversion tracking",
    vendors: ["Google Ads Conversion"],
    slugs: ["google_ads"],
  },
  { label: "TikTok Pixel", vendors: ["TikTok Pixel"], slugs: ["tiktok_pixel"] },
  { label: "LinkedIn Insight Tag", vendors: ["LinkedIn Insight"], slugs: ["linkedin_insight"] },
];

export function buildTracking(capture: CaptureResult): TrackingSection {
  const record = capture.record;
  const signals = detectTracking(record);
  // An absent script list means nothing was inspected. Reporting "no pixel was
  // detected" from that would be asserting absence from missing data.
  const capturedScripts = record.technical_snapshot?.scripts ?? capture.snapshot.scripts;
  const scriptsObserved = Array.isArray(capturedScripts);
  const scripts: ScriptRecord[] = capturedScripts ?? [];

  const idsBySlug = extractIds(scripts);
  const detected: TrackingVendor[] = signals.map((signal) => {
    const profile = profileFor(signal);
    const matched = idsBySlug.get(profile.slug);
    const evidence = [shorten(signal.evidence)];
    for (const match of matched ?? []) {
      if (evidence.length >= MAX_EVIDENCE_PER_VENDOR) break;
      evidence.push(shorten(`id ${match.id} in ${match.source}`));
    }
    return {
      vendor: signal.vendor,
      category: profile.category,
      evidence,
      ids: (matched ?? []).map((match) => match.id),
    };
  });

  const categories = new Set(detected.map((vendor) => vendor.category));
  const detectedVendorNames = new Set(detected.map((vendor) => vendor.vendor));

  const ids: Record<string, string[]> = {};
  for (const [slug, matches] of idsBySlug) {
    ids[slug] = matches.map((match) => match.id);
  }

  return {
    detected,
    has_analytics: categories.has("analytics"),
    has_advertising_pixel: categories.has("advertising_pixel"),
    has_tag_manager: categories.has("tag_manager"),
    ids,
    third_party_script_hosts: thirdPartyHosts(record),
    script_count: scripts.length,
    statements: scriptsObserved
      ? buildStatements(detectedVendorNames, detected, idsBySlug)
      : [
          "The rendered page scripts were not captured, so the presence or absence of tracking could not be established.",
        ],
  };
}

interface IdMatch {
  id: string;
  source: string;
}

function profileFor(signal: TrackingSignal): VendorProfile {
  const known = VENDOR_PROFILES[signal.vendor];
  if (known) return known;
  return { slug: slugify(signal.vendor), category: KIND_CATEGORY[signal.kind] ?? "other" };
}

function slugify(vendor: string): string {
  return vendor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Only IDs literally present in a script src or inline snippet are reported. */
function extractIds(scripts: ScriptRecord[]): Map<string, IdMatch[]> {
  const pieces: string[] = [];
  for (const script of scripts) {
    if (script.src) pieces.push(script.src);
    if (script.inline_snippet) pieces.push(script.inline_snippet);
  }

  const found = new Map<string, IdMatch[]>();
  for (const piece of pieces) {
    for (const rule of ID_PATTERNS) {
      if (rule.requires && !rule.requires.test(piece)) continue;
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(piece)) !== null) {
        const id = match[1] ?? match[0];
        if (!id) continue;
        const bucket = found.get(rule.slug) ?? [];
        if (!bucket.some((entry) => entry.id === id)) {
          bucket.push({ id, source: shorten(piece, 120) });
          found.set(rule.slug, bucket);
        }
      }
    }
  }
  return found;
}

function buildStatements(
  detectedVendorNames: Set<string>,
  detected: TrackingVendor[],
  idsBySlug: Map<string, IdMatch[]>,
): string[] {
  const statements: string[] = [];
  const covered = new Set<string>();

  for (const family of STATEMENT_FAMILIES) {
    for (const vendor of family.vendors) covered.add(vendor);
    const ids = family.slugs.flatMap((slug) => (idsBySlug.get(slug) ?? []).map((match) => match.id));
    const present = family.vendors.some((vendor) => detectedVendorNames.has(vendor)) || ids.length > 0;
    statements.push(
      present
        ? `${family.label} was detected in the rendered page${idSuffix(ids)}.`
        : `No ${family.label} was detected in the rendered page.`,
    );
  }

  for (const vendor of detected) {
    if (covered.has(vendor.vendor)) continue;
    statements.push(`${vendor.vendor} was detected in the rendered page${idSuffix(vendor.ids)}.`);
  }

  return statements;
}

function idSuffix(ids: string[]): string {
  if (ids.length === 0) return "";
  if (ids.length === 1) return ` (id ${ids[0]})`;
  return ` (ids ${ids.join(", ")})`;
}

function shorten(text: string, limit = EVIDENCE_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}
