import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, FoldPosition, ImageRecord } from "../../types/index.js";
import type { SocialProofSection, TestimonialEntry } from "../landing_types.js";

/** A heading, paragraph or list item with the position it was rendered at. */
interface Block {
  text: string;
  position: FoldPosition;
  y: number;
}

const LOGO_HINT =
  /(?:^|[^a-z])logos?(?:[^a-z]|$)|brand[-_ ]?mark|client[-_ ]?logo|partner[-_ ]?logo|press[-_ ]?logo|as[-_ ]?seen|featured[-_ ]?(?:in|on)|trusted[-_ ]?by/i;

const PROOF_SECTION_HEADING =
  /as seen (?:in|on)|featured (?:in|on)|trusted by|our clients|partners|brands/i;

const MENTION_RE = /\b(?:as seen (?:in|on)|featured (?:in|on)|mentioned (?:in|on))\b/i;

const PUBLICATIONS = [
  "Forbes", "Entrepreneur", "Inc. Magazine", "Inc.", "Business Insider", "TechCrunch",
  "Bloomberg", "CNBC", "CNN", "BBC", "NBC", "ABC News", "CBS", "Fox News", "Fox Business",
  "Wall Street Journal", "WSJ", "New York Times", "NYT", "USA Today", "Washington Post",
  "HuffPost", "Huffington Post", "Wired", "Fast Company", "Mashable", "Yahoo Finance",
  "Yahoo", "Reuters", "The Guardian", "Financial Times", "The Economist", "Newsweek",
  "Time Magazine", "Vogue", "GQ", "Men's Health", "Women's Health", "Shape", "Vice",
  "BuzzFeed", "ESPN", "Product Hunt", "Hacker News", "Vox", "Axios", "Fortune",
  "Harvard Business Review", "Success Magazine", "Rolling Stone", "Billboard",
];

const COUNT_UNITS =
  "students|clients|customers|members|users|founders|businesses|companies|entrepreneurs|reviews|ratings|families|patients|coaches|leads|subscribers|downloads|graduates|athletes|attendees|participants|women|men|people|projects|orders|deals|calls|appointments|installs|stores|agencies|creators|practitioners|professionals|teams";

const COUNT_RE = new RegExp(
  `\\b(\\d{1,3}(?:,\\d{3})+|\\d{2,}(?:\\.\\d+)?\\s?[kKmM]?\\+?|\\d+\\s?[kKmM]\\+?)\\s+(?:happy |satisfied |active |paying |global |serious |real )?(?:${COUNT_UNITS})\\b`,
  "gi",
);

const MONEY_RE = /(?:\$|£|€)\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|b|million|billion)?\+?/gi;
const MONEY_PROOF_CONTEXT =
  /\b(revenue|sales|generated|generating|profit|funding|raised|saved|savings|closed|collected|earned|returned|roi|in commissions|in bookings|in contracts)\b/i;
const PRICE_CONTEXT =
  /\b(only|just|price|pricing|payment|payments|installments?|per month|per year|\/mo|\/month|deposit|value|worth|save|off|discount|retail|normally|regularly|billed)\b/i;

const PERCENT_RE = /\b\d{1,3}(?:\.\d+)?\s?%/g;
const PERCENT_PROOF_CONTEXT =
  /\b(success|conversion|completion|satisfaction|retention|show[- ]?up|open|close|response|pass|placement|growth|increase|increased|decrease|reduction|reduced|more|faster|higher|lower|rate|of (?:our |all )?(?:students|clients|customers|members|users))\b/i;

const MULTIPLIER_RE = /\b\d{1,2}(?:\.\d)?x\b/gi;
const MULTIPLIER_PROOF_CONTEXT =
  /\b(growth|grew|increase|increased|more|roi|return|revenue|leads|traffic|conversions|sales|faster|bigger|higher|results)\b/i;

const TIME_UNIT_AFTER = /^\s*(?:am|pm|a\.m\.|p\.m\.|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i;

const RATING_PATTERNS: Array<{ re: RegExp; scaleGroup: number | null }> = [
  { re: /\b(\d(?:\.\d)?)\s*\/\s*(5|10)\b/g, scaleGroup: 2 },
  { re: /\b(\d(?:\.\d)?)\s*out of\s*(5|10)\b/gi, scaleGroup: 2 },
  { re: /\brated\s+(\d(?:\.\d)?)\s*stars?\b/gi, scaleGroup: null },
  { re: /\b(\d(?:\.\d)?)[\s-]stars?\b/gi, scaleGroup: null },
];

const AUTHORITY_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "certification",
    re: /\b(?:certified|certification|accredited|licensed|board[- ]certified|iso\s?\d{4,5}|nasm|issa|ace[- ]certified|cpa|pmp|cfa|cfp|rn|lcsw)\b/i,
  },
  {
    kind: "award",
    re: /\b(?:award[- ]winning|award winner|winner of|nominated for|#1\s+(?:best|bestsell|rated|ranked)|best[- ]sell(?:ing|er)|bestsell(?:ing|er)|top \d{1,3}\s+(?:in|list|of))\b/i,
  },
  {
    kind: "credential",
    re: /\b(?:ph\.?d\.?|m\.?d\.?|mba|dds|dvm|esq\.?|professor at|former (?:head|director|vp|executive|engineer|manager) (?:of|at)|ex-(?:google|meta|facebook|amazon|apple|microsoft|netflix))\b/i,
  },
  {
    kind: "official_partner",
    re: /\b(?:official(?:ly)? (?:partner|certified|licensed|approved)|authorized (?:partner|reseller|dealer|trainer)|(?:google|meta|facebook|hubspot|shopify|aws|microsoft|klaviyo|salesforce) (?:premier |certified )?partner)\b/i,
  },
  {
    kind: "years_in_business",
    re: /\b(?:(?:over|more than)\s+)?\d{1,3}\+?\s*years?\s+(?:of\s+)?(?:experience|in business|in the industry|serving|helping|coaching|training|practice)\b|\b(?:since|established|est\.)\s+(?:19|20)\d{2}\b/i,
  },
  {
    kind: "media_feature_badge",
    re: /\b(?:seen (?:in|on)|featured (?:in|on)|published (?:in|by))\b/i,
  },
];

const BADGE_IMAGE_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "security",
    re: /\b(?:ssl|secure(?:d)? checkout|256[- ]bit|norton|mcafee|verisign|trustpilot|trust ?seal|privacy protected|gdpr|pci)\b/i,
  },
  {
    kind: "payment",
    re: /\b(?:visa|mastercard|amex|american express|paypal|stripe|apple pay|google pay|klarna|afterpay|shop pay|discover card|secure payment)\b/i,
  },
  {
    kind: "guarantee",
    re: /\b(?:money[- ]back|\d{1,3}[- ]day guarantee|satisfaction guarantee(?:d)?|risk[- ]free|guarantee(?:d)? badge)\b/i,
  },
];

/** In prose, brand words like "visa" are ambiguous, so the text set is narrower. */
const BADGE_TEXT_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "security",
    re: /\b(?:ssl (?:secured|encrypted|certificate)|secure(?:d)? checkout|256[- ]bit encryption|norton secured|mcafee secure|verisign|pci compliant|gdpr compliant|your (?:information|data) is (?:safe|secure))\b/i,
  },
  {
    kind: "payment",
    re: /\b(?:secure payment|payments? (?:processed|powered) by (?:stripe|paypal)|100% secure checkout)\b/i,
  },
  {
    kind: "guarantee",
    re: /\b(?:money[- ]back guarantee|\d{1,3}[- ]day (?:money[- ]back )?guarantee|satisfaction guaranteed|100% (?:risk[- ]free|guaranteed)|risk[- ]free)\b/i,
  },
];

const CASE_METRIC =
  /(?:\$\s?[\d,]+|\b\d{1,3}(?:\.\d+)?\s?%|\b\d{1,2}(?:\.\d)?x\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+\s?(?:lbs?|pounds|kg|clients|leads|calls|sales|deals|students|hours)\b)/i;
const CASE_TRANSFORMATION =
  /\b(?:went from|grew|scaled|increased|doubled|tripled|quadrupled|reduced|cut|dropped|lost|gained|added|generated|closed|landed|booked|improved|boosted|turned .{0,30} into|took .{0,30} from|replaced (?:her|his|their|my) (?:income|salary|job))\b/i;

/**
 * Everything on the page that is presented as proof, reported as observed.
 * Each array is independently allowed to be empty.
 */
export function buildSocialProof(
  capture: CaptureResult,
  testimonials: TestimonialEntry[],
): SocialProofSection {
  const snapshot = capture.snapshot;
  const blocks = collectBlocks(snapshot);

  const logos = collectLogos(snapshot);
  const mentions = collectMediaMentions(blocks);
  const numericClaims = collectNumericClaims(capture, blocks);
  const ratings = collectRatings(blocks);
  const authority = collectAuthority(blocks, snapshot.images);
  const badges = collectTrustBadges(blocks, snapshot.images);
  const caseStudies = collectCaseStudies(blocks);

  const aboveFold =
    testimonials.filter((t) => t.above_fold).length +
    countAboveFold(logos) +
    countAboveFold(mentions) +
    countAboveFold(numericClaims) +
    countAboveFold(ratings) +
    countAboveFold(authority) +
    countAboveFold(badges) +
    countAboveFold(caseStudies);

  return {
    testimonial_count: testimonials.length,
    client_logos: logos.map((logo) => ({ src: logo.src, alt: logo.alt })),
    media_mentions: mentions.map((m) => ({ text: m.text, outlet: m.outlet })),
    numeric_claims: numericClaims.map((c) => ({ text: c.text, value: c.value })),
    ratings: ratings.map((r) => ({ value: r.value, scale: r.scale, source_text: r.source_text })),
    authority_indicators: authority.map((a) => ({ kind: a.kind, text: a.text })),
    trust_badges: badges.map((b) => ({ kind: b.kind, text: b.text })),
    case_studies: caseStudies.map((c) => ({ text: c.text, position: c.position })),
    above_fold_proof_count: aboveFold,
  };
}

interface Positioned {
  position: FoldPosition;
}

function countAboveFold(items: Positioned[]): number {
  return items.filter((item) => item.position === "above_fold").length;
}

function collectBlocks(snapshot: DomSnapshot): Block[] {
  const blocks: Block[] = [];
  for (const heading of snapshot.headings) {
    blocks.push({ text: heading.text, position: heading.position, y: heading.y });
  }
  for (const paragraph of snapshot.paragraphs) {
    blocks.push({ text: paragraph.text, position: paragraph.position, y: paragraph.y });
  }
  return blocks.sort((a, b) => a.y - b.y);
}

/* ------------------------------- logos -------------------------------- */

interface LogoEntry extends Positioned {
  src: string | null;
  alt: string | null;
}

function collectLogos(snapshot: DomSnapshot): LogoEntry[] {
  const entries: LogoEntry[] = [];
  const seen = new Set<string>();
  const proofSections = (snapshot.sections || []).filter(
    (section) => section.heading && PROOF_SECTION_HEADING.test(section.heading),
  );
  const proofFolds = new Set<FoldPosition>(
    proofSections.map((section) => (section.y < snapshot.viewport.height ? "above_fold" : "below_fold")),
  );

  for (const image of snapshot.images) {
    if (image.width < 40 || image.height < 20) continue;
    const haystack = `${image.alt || ""} ${image.src || ""}`;
    const named = LOGO_HINT.test(haystack);
    // Images carry no y in the snapshot, so membership of a "trusted by" band
    // can only be approximated: the page must actually have such a section, and
    // the image must be logo-shaped and on the same side of the fold.
    const inProofBand =
      !named &&
      proofFolds.has(image.position) &&
      image.visible &&
      isLogoShaped(image) &&
      wordCount(image.alt) <= 6;
    if (!named && !inProofBand) continue;

    const key = image.src || `alt:${image.alt || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ src: image.src, alt: image.alt, position: image.position });
    if (entries.length >= 40) break;
  }

  return entries;
}

function isLogoShaped(image: ImageRecord): boolean {
  if (image.height > 180) return false;
  return image.width / Math.max(image.height, 1) >= 1.3;
}

function wordCount(value: string | null): number {
  if (!value) return 0;
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/* --------------------------- media mentions ---------------------------- */

interface MentionEntry extends Positioned {
  text: string;
  outlet: string | null;
}

function collectMediaMentions(blocks: Block[]): MentionEntry[] {
  const entries: MentionEntry[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const match = block.text.match(MENTION_RE);
    if (!match || match.index === undefined) continue;
    const key = normalize(block.text).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      text: clip(block.text),
      outlet: outletAfter(block.text.slice(match.index + match[0].length)),
      position: block.position,
    });
    if (entries.length >= 20) break;
  }

  return entries;
}

function outletAfter(tail: string): string | null {
  const window = tail.slice(0, 80);
  for (const publication of PUBLICATIONS) {
    const index = window.toLowerCase().indexOf(publication.toLowerCase());
    if (index >= 0) return window.slice(index, index + publication.length);
  }
  return null;
}

/* --------------------------- numeric claims ---------------------------- */

interface ClaimEntry extends Positioned {
  text: string;
  value: string;
}

function collectNumericClaims(capture: CaptureResult, blocks: Block[]): ClaimEntry[] {
  const entries: ClaimEntry[] = [];
  const seen = new Set<string>();

  const push = (text: string, value: string, position: FoldPosition): void => {
    const cleaned = value.trim();
    if (!cleaned) return;
    const key = `${normalize(cleaned)}|${normalize(text).slice(0, 60)}`;
    if (seen.has(key) || entries.length >= 40) return;
    seen.add(key);
    entries.push({ text: clip(text), value: cleaned, position });
  };

  for (const block of blocks) {
    for (const match of block.text.matchAll(COUNT_RE)) {
      if (match.index === undefined) continue;
      if (followedByTimeUnit(block.text, match.index + match[0].length)) continue;
      push(block.text, match[1] as string, block.position);
    }

    for (const match of block.text.matchAll(MONEY_RE)) {
      if (match.index === undefined) continue;
      const context = around(block.text, match.index, match[0].length, 60);
      if (!MONEY_PROOF_CONTEXT.test(context)) continue;
      if (PRICE_CONTEXT.test(around(block.text, match.index, match[0].length, 30))) continue;
      push(block.text, match[0], block.position);
    }

    for (const match of block.text.matchAll(PERCENT_RE)) {
      if (match.index === undefined) continue;
      const context = around(block.text, match.index, match[0].length, 50);
      if (!PERCENT_PROOF_CONTEXT.test(context)) continue;
      if (/\b(?:save|off|discount)\b/i.test(around(block.text, match.index, match[0].length, 20))) continue;
      push(block.text, match[0], block.position);
    }

    for (const match of block.text.matchAll(MULTIPLIER_RE)) {
      if (match.index === undefined) continue;
      if (!MULTIPLIER_PROOF_CONTEXT.test(around(block.text, match.index, match[0].length, 50))) continue;
      push(block.text, match[0], block.position);
    }
  }

  // The detector also counts quantified phrases straight out of the visible
  // text, which reaches counters that are not paragraphs or headings.
  for (const item of capture.record.social_proof) {
    if (item.kind !== "quantified_number") continue;
    const value = item.text.match(/\d{1,3}(?:,\d{3})+|\d+\+?/)?.[0];
    if (!value) continue;
    push(item.text, value, item.position);
  }

  return entries;
}

function followedByTimeUnit(text: string, end: number): boolean {
  return TIME_UNIT_AFTER.test(text.slice(end, end + 16));
}

function around(text: string, index: number, length: number, radius: number): string {
  return text.slice(Math.max(0, index - radius), index + length + radius);
}

/* ------------------------------ ratings -------------------------------- */

interface RatingEntry extends Positioned {
  value: string;
  scale: string | null;
  source_text: string;
}

function collectRatings(blocks: Block[]): RatingEntry[] {
  const entries: RatingEntry[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (DATE_LIKE.test(block.text)) continue;
    for (const pattern of RATING_PATTERNS) {
      for (const match of block.text.matchAll(pattern.re)) {
        const value = match[1] as string;
        const numeric = Number(value);
        const scale = pattern.scaleGroup ? (match[pattern.scaleGroup] as string) : null;
        const upper = scale ? Number(scale) : 5;
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric > upper) continue;
        const key = `${value}|${scale ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ value, scale, source_text: clip(block.text), position: block.position });
        if (entries.length >= 20) return entries;
      }
    }
  }

  return entries;
}

const DATE_LIKE = /\b\d{1,4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,4}\b/;

/* -------------------------- authority & badges ------------------------- */

interface KindEntry extends Positioned {
  kind: string;
  text: string;
}

function collectAuthority(blocks: Block[], images: ImageRecord[]): KindEntry[] {
  const entries: KindEntry[] = [];
  const seen = new Set<string>();

  const push = (kind: string, text: string, position: FoldPosition): void => {
    const key = `${kind}|${normalize(text).slice(0, 70)}`;
    if (seen.has(key) || entries.length >= 30) return;
    seen.add(key);
    entries.push({ kind, text: clip(text), position });
  };

  for (const block of blocks) {
    if (block.text.length > 400) continue;
    for (const pattern of AUTHORITY_PATTERNS) {
      // A press badge is only reported here when it is an image; the prose form
      // is already reported as a media mention.
      if (pattern.kind === "media_feature_badge") continue;
      if (pattern.re.test(block.text)) push(pattern.kind, block.text, block.position);
    }
  }

  for (const image of images) {
    const haystack = `${image.alt || ""} ${image.src || ""}`;
    for (const pattern of AUTHORITY_PATTERNS) {
      if (!pattern.re.test(haystack)) continue;
      const label = image.alt || image.src;
      if (!label) continue;
      push(pattern.kind === "media_feature_badge" ? "press_badge" : pattern.kind, label, image.position);
    }
  }

  return entries;
}

function collectTrustBadges(blocks: Block[], images: ImageRecord[]): KindEntry[] {
  const entries: KindEntry[] = [];
  const seen = new Set<string>();

  const push = (kind: string, text: string, position: FoldPosition): void => {
    const key = `${kind}|${normalize(text).slice(0, 70)}`;
    if (seen.has(key) || entries.length >= 30) return;
    seen.add(key);
    entries.push({ kind, text: clip(text), position });
  };

  for (const image of images) {
    const label = image.alt || image.src;
    if (!label) continue;
    const haystack = `${image.alt || ""} ${image.src || ""}`;
    for (const pattern of BADGE_IMAGE_PATTERNS) {
      if (pattern.re.test(haystack)) push(pattern.kind, label, image.position);
    }
  }

  for (const block of blocks) {
    if (block.text.length > 160) continue;
    for (const pattern of BADGE_TEXT_PATTERNS) {
      if (pattern.re.test(block.text)) push(pattern.kind, block.text, block.position);
    }
  }

  return entries;
}

/* ---------------------------- case studies ----------------------------- */

interface CaseStudyEntry extends Positioned {
  text: string;
}

function collectCaseStudies(blocks: Block[]): CaseStudyEntry[] {
  const entries: CaseStudyEntry[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    // Short stat tiles carry a metric without telling a story; a case study
    // needs both a measurable result and a change described in words.
    if (block.text.length < 40 || block.text.length > 900) continue;
    if (!CASE_METRIC.test(block.text) || !CASE_TRANSFORMATION.test(block.text)) continue;
    const key = normalize(block.text).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ text: clip(block.text), position: block.position });
    if (entries.length >= 20) break;
  }

  return entries;
}

/* ------------------------------- helpers ------------------------------- */

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
