import type { CaptureResult } from "../../pipeline/capture.js";
import type { HeadingRecord, ImageRecord, TextBlock } from "../../types/index.js";
import {
  detected,
  unknown,
  type CtaEntry,
  type HeroCta,
  type HeroSection,
  type VideoEntry,
} from "../landing_types.js";

const MAX_SUPPORTING_COPY = 5;
const MAX_TRUST_ELEMENTS = 12;
const SUBHEADLINE_MIN_LENGTH = 21;
/** Below this an above-the-fold image is decoration (icon, avatar, spacer), not hero media. */
const MIN_HERO_IMAGE_WIDTH = 200;
const MIN_HERO_IMAGE_HEIGHT = 150;

const RATING_PATTERN =
  /\b\d(?:\.\d)?\s*(?:\/|out of)\s*5\b|\b\d(?:\.\d)?\s*[- ]?star(?:s|\srating)?\b|\b\d(?:\.\d)?\s*stars\b/i;
const MEDIA_MENTION_PATTERN = /\bas\s+(?:seen|featured)\s+(?:in|on)\b|\bfeatured\s+(?:in|on)\b/i;
const GUARANTEE_PATTERN =
  /\bguarantee[ds]?\b|\bmoney[-\s]?back\b|\brisk[-\s]?free\b|\bfull\s+refund\b|\brefund\s+policy\b/i;
/**
 * "Secure your spot" is CTA copy, not a security signal, so bare "secure" is
 * excluded and only explicit security/privacy assurances count.
 */
const SECURITY_PATTERN =
  /\bssl\b|\b256[-\s]?bit\b|\bencrypted\b|\bsecure\s+(?:checkout|payment|order|form)\b|\b100%\s+secure\b|\bno\s+spam\b|\bspam[-\s]free\b|\bwe\s+respect\s+your\s+privacy\b|\byour\s+(?:information|data|privacy|email)\s+is\s+(?:safe|secure|protected)\b/i;
const LOGO_PATTERN = /logo|as[-_\s]?seen|featured|press/i;

/**
 * A headline "names an outcome or audience" when it carries an action/state verb
 * or a "for <audience>" phrase. The negative lookahead drops the common
 * non-audience uses of "for" ("for free", "for a limited time", "for $97").
 */
const OUTCOME_VERB_PATTERN =
  /\b(?:get|gets|getting|grow|grows|growing|build|builds|building|learn|learns|learning|discover|discovers|discovering|scale|scales|scaling|start|starts|starting|stop|stops|stopping|create|creates|creating|make|makes|making|turn|turns|turning|double|doubles|doubling|triple|triples|increase|increases|increasing|boost|boosts|boosting|launch|launches|launching|master|masters|mastering|save|saves|saving|earn|earns|earning|generate|generates|generating|attract|attracts|attracting|book|books|booking|close|closes|closing|lose|loses|losing|gain|gains|gaining|transform|transforms|transforming|unlock|unlocks|unlocking|become|becomes|becoming|help|helps|helping|achieve|achieves|achieving|land|lands|landing|win|wins|winning|cut|cuts|cutting|reduce|reduces|reducing|eliminate|eliminates|eliminating|automate|automates|automating|convert|converts|converting|sell|sells|selling|hire|hires|hiring|join|joins|joining|apply|applies|applying|register|registers|registering|download|downloads|downloading|find|finds|finding|fix|fixes|fixing|show|shows|showing|is|are|was|were|will|can|need|needs|want|wants|know|knows|have|has|take|takes|work|works|works)\b/i;
const AUDIENCE_PATTERN =
  /\bfor\s+(?!free\b|a\s|an\s|the\s+(?:next|first|price|low)\b|less\b|only\b|just\b|now\b|\$|\d)(?:[a-z][a-z-]*\s+){0,2}[a-z][a-z-]{2,}\b/i;

export function buildHero(
  capture: CaptureResult,
  ctas: CtaEntry[],
  videos: VideoEntry[],
): HeroSection {
  const snapshot = capture.snapshot;
  const foldHeight = snapshot.viewport.height;
  const aboveFold = (y: number): boolean => y < foldHeight;

  const heroHeadings = snapshot.headings.filter((h) => aboveFold(h.y) && h.text.trim().length > 0);
  const heroParagraphs = snapshot.paragraphs.filter(
    (p) => aboveFold(p.y) && p.text.trim().length > 0,
  );

  const headlineRecord = pickHeadline(heroHeadings);
  const headline = headlineRecord
    ? headlineRecord.text.trim()
    : nonEmpty(capture.record.above_the_fold.hero_heading);

  const subheadlineRecord = pickSubheadline(heroHeadings, heroParagraphs, headlineRecord, headline);
  const subheadline = subheadlineRecord ? subheadlineRecord.text.trim() : null;

  const used = new Set<string>();
  if (headline) used.add(headline);
  if (subheadline) used.add(subheadline);
  const supportingCopy: string[] = [];
  for (const paragraph of heroParagraphs) {
    if (supportingCopy.length >= MAX_SUPPORTING_COPY) break;
    const text = paragraph.text.trim();
    if (used.has(text)) continue;
    used.add(text);
    supportingCopy.push(text);
  }

  const aboveFoldCtas = ctas.filter((cta) => cta.above_fold);
  const primaryEntry =
    aboveFoldCtas.find((cta) => cta.is_primary) ?? aboveFoldCtas.find((cta) => cta.visible) ?? null;
  const secondaryEntries = aboveFoldCtas.filter((cta) => cta !== primaryEntry);
  const ctaAboveFold = ctas.some((cta) => cta.visible && cta.above_fold);

  const trustElements = collectTrustElements(capture, heroHeadings, heroParagraphs);
  const media = pickMedia(videos, snapshot.images);

  return {
    fold_height: foldHeight,
    headline,
    subheadline,
    supporting_copy: supportingCopy,
    primary_cta: primaryEntry ? toHeroCta(primaryEntry) : null,
    secondary_ctas: secondaryEntries.map(toHeroCta),
    cta_above_fold: ctaAboveFold,
    offer: nonEmpty(capture.record.above_the_fold.primary_offer),
    trust_elements: trustElements,
    media,
    value_proposition: judgeValueProposition(headline, subheadline, supportingCopy, ctaAboveFold),
  };
}

function pickHeadline(heroHeadings: HeadingRecord[]): HeadingRecord | null {
  return (
    heroHeadings.find((h) => h.visible && h.level === 1) ??
    heroHeadings.find((h) => h.visible) ??
    heroHeadings[0] ??
    null
  );
}

function pickSubheadline(
  heroHeadings: HeadingRecord[],
  heroParagraphs: TextBlock[],
  headlineRecord: HeadingRecord | null,
  headline: string | null,
): HeadingRecord | TextBlock | null {
  const isNext = (h: HeadingRecord): boolean =>
    h !== headlineRecord && h.text.trim() !== headline && (!headlineRecord || h.y >= headlineRecord.y);
  const nextHeading = heroHeadings.find((h) => h.visible && isNext(h)) ?? heroHeadings.find(isNext);
  if (nextHeading) return nextHeading;

  return (
    heroParagraphs.find(
      (p) =>
        p.visible && p.text.trim().length >= SUBHEADLINE_MIN_LENGTH && p.text.trim() !== headline,
    ) ?? null
  );
}

function toHeroCta(cta: CtaEntry): HeroCta {
  return {
    text: cta.text,
    type: cta.type,
    href: cta.href,
    above_fold: cta.above_fold,
  };
}

function collectTrustElements(
  capture: CaptureResult,
  heroHeadings: HeadingRecord[],
  heroParagraphs: TextBlock[],
): { kind: string; text: string }[] {
  const elements: { kind: string; text: string }[] = [];
  const seen = new Set<string>();

  const add = (kind: string, raw: string | null): void => {
    if (elements.length >= MAX_TRUST_ELEMENTS) return;
    const text = quote(raw);
    if (!text) return;
    const key = `${kind}|${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    elements.push({ kind, text });
  };

  for (const testimonial of capture.record.testimonials) {
    if (testimonial.position !== "above_fold") continue;
    add("testimonial", testimonial.text);
  }

  for (const proof of capture.record.social_proof) {
    if (proof.position !== "above_fold") continue;
    add(proof.kind, proof.text);
  }

  for (const image of capture.snapshot.images) {
    if (image.position !== "above_fold" || !image.visible) continue;
    if (!LOGO_PATTERN.test(`${image.alt ?? ""} ${image.src ?? ""}`)) continue;
    add("logo", image.alt || image.src);
  }

  const blocks = [...heroHeadings, ...heroParagraphs]
    .filter((block) => block.visible)
    .sort((a, b) => a.y - b.y);
  for (const block of blocks) {
    const text = block.text;
    if (RATING_PATTERN.test(text)) add("rating", text);
    if (MEDIA_MENTION_PATTERN.test(text)) add("media_mention", text);
    if (GUARANTEE_PATTERN.test(text)) add("guarantee", text);
    if (SECURITY_PATTERN.test(text)) add("security", text);
  }

  return elements;
}

function pickMedia(videos: VideoEntry[], images: ImageRecord[]): HeroSection["media"] {
  const video = videos.find((entry) => entry.above_fold);
  if (video) {
    return {
      kind: "video",
      provider: video.provider,
      src: video.src,
      width: video.width,
      height: video.height,
    };
  }

  let largest: ImageRecord | null = null;
  for (const image of images) {
    if (image.position !== "above_fold" || !image.visible) continue;
    if (image.width < MIN_HERO_IMAGE_WIDTH || image.height < MIN_HERO_IMAGE_HEIGHT) continue;
    if (!largest || image.width * image.height > largest.width * largest.height) largest = image;
  }
  if (largest) {
    return {
      kind: "image",
      provider: null,
      src: largest.src,
      width: largest.width,
      height: largest.height,
    };
  }

  return { kind: "none", provider: null, src: null, width: null, height: null };
}

function judgeValueProposition(
  headline: string | null,
  subheadline: string | null,
  supportingCopy: string[],
  ctaAboveFold: boolean,
): HeroSection["value_proposition"] {
  if (!headline) {
    return unknown("No above-the-fold headline was detected");
  }

  const namesOutcomeOrAudience =
    OUTCOME_VERB_PATTERN.test(headline) || AUDIENCE_PATTERN.test(headline);
  const hasSupport = Boolean(subheadline) || supportingCopy.length > 0;

  const evidence: string[] = [`Headline: "${quote(headline)}"`];
  if (subheadline) evidence.push(`Subheadline: "${quote(subheadline)}"`);
  else if (supportingCopy.length) evidence.push(`Supporting copy: "${quote(supportingCopy[0])}"`);
  evidence.push(
    ctaAboveFold
      ? "A visible call to action is above the fold"
      : "No visible call to action is above the fold",
  );

  const missing: string[] = [];
  if (!namesOutcomeOrAudience) {
    missing.push("headline states no action, outcome or named audience");
  }
  if (!hasSupport) missing.push("no subheadline or supporting copy above the fold");
  if (!ctaAboveFold) missing.push("no visible call to action above the fold");

  if (!missing.length) {
    return detected({ clarity: "clear", statement: headline }, 0.8, evidence);
  }

  evidence.push(`Missing: ${missing.join("; ")}`);
  return detected({ clarity: "unclear", statement: headline }, 0.6, evidence);
}

function quote(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function nonEmpty(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length ? text : null;
}
