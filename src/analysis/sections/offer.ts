import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot } from "../../types/index.js";
import {
  detected,
  unknown,
  type CtaEntry,
  type Determination,
  type GuaranteesSection,
  type OfferSection,
  type PricingSection,
} from "../landing_types.js";

const MAX_LIST = 15;
const TEXT_CHARS = 240;
const MIN_WORDS_FOR_CLARITY = 40;

/** A "what you get" list is short and sits together; see extractDeliverables. */
const MAX_DELIVERABLE_RUN = 8;
const ITEM_MIN_CHARS = 8;
const ITEM_MAX_CHARS = 120;
const ITEM_MAX_WORDS = 20;
const RUN_GAP_PX = 400;

/** One visible block of page copy, in document order. */
interface CopyBlock {
  text: string;
  y: number;
  heading: boolean;
}

/** Where a product noun was read from, and how much that placement is worth. */
interface ProductSource {
  text: string;
  label: string;
  confidence: number;
}

/** Nouns that name something a visitor actually receives. */
const DELIVERABLE_NOUN =
  /\b(call|audit|review|session|consultation|course|program(?:me)?|training|workshop|masterclass|webinar|coaching|mentorship|template|checklist|guide|playbook|blueprint|toolkit|framework|software|app|platform|community|membership|newsletter|ebook|report|teardown|strategy session)\b/i;

/**
 * An audience is a group of people, so every pattern must end on an audience
 * noun. Free-form captures like "if you are serious about your business" read as
 * an audience statement but name no group, and inventing one from that phrasing
 * is exactly the failure this section must not produce.
 */
const AUDIENCE_NOUN =
  "founders?|owners?|business owners?|agency owners?|agencies|coaches?|consultants?|freelancers?|marketers?|creators?|entrepreneurs?|solopreneurs?|therapists?|dentists?|chiropractors?|realtors?|real estate agents?|lawyers?|attorneys?|accountants?|authors?|speakers?|students?|teams?|businesses|companies|startups?|smes?|smbs?|professionals?|beginners?|experts?|practitioners?|developers?|designers?|writers?|photographers?|trainers?|nutritionists?|parents?|moms?|dads?|women|men|leaders?|managers?|executives?|ceos?|founders and operators?";

const AUDIENCE_PATTERNS = [
  new RegExp(`\\bfor\\s+((?:[a-z0-9][\\w'-]*\\s+){0,3}(?:${AUDIENCE_NOUN}))\\b`, "i"),
  new RegExp(`\\bif you(?:'re| are)\\s+(?:an?\\s+)?((?:[a-z0-9][\\w'-]*\\s+){0,3}(?:${AUDIENCE_NOUN}))\\b`, "i"),
  new RegExp(`\\bhelping\\s+((?:[a-z0-9][\\w'-]*\\s+){0,3}(?:${AUDIENCE_NOUN}))\\b`, "i"),
  new RegExp(`\\b(?:built|designed|made)\\s+for\\s+((?:[a-z0-9][\\w'-]*\\s+){0,3}(?:${AUDIENCE_NOUN}))\\b`, "i"),
  new RegExp(`\\bwe help\\s+((?:[a-z0-9][\\w'-]*\\s+){0,3}(?:${AUDIENCE_NOUN}))\\b`, "i"),
];

const MECHANISM_PATTERNS = [
  /\b(?:our|the|my|a)\s+(\d+[-\s]?(?:step|stage|phase|part|pillar)\s+(?:system|process|framework|method|formula|blueprint|roadmap))\b/i,
  /\b(?:the|our|my)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,3}\s+(?:Method|System|Framework|Formula|Blueprint|Process|Model))\b/,
  /\b(?:using|through|via)\s+(?:our|the|a)\s+([^.,!?]{3,60}(?:system|process|framework|method|formula))\b/i,
];

const DELIVERABLE_LEAD =
  /\b(?:you(?:'ll| will)?\s+(?:get|receive|walk away with)|includes?|including|what(?:'s| is) included|here(?:'s| is) what you get|comes with)\b/i;

/**
 * A deliverable noun standing on its own in a nav item or a footer heading
 * ("Community", "Newsletter") names nothing the page is selling. Only a noun
 * inside a phrase counts: a determiner, quantity or adjective in front of it,
 * or a second deliverable noun compounded after it.
 */
const QUALIFIER_BEFORE =
  /(?:\b(?:a|an|the|this|that|these|those|our|your|my|their|its|his|her|one|two|three|free|new|full|live|online|private|personal|group|custom|proven|digital|exclusive|premium|weekly|monthly|daily|next|first|best|top)\b|\b\d+[-\s]?(?:minute|min|hour|hr|day|week|month|part|step|module|page)s?\b|\b[a-z]{3,}(?:ing|ed|ive|al|ic|ous|ful|less|able|ible|ary|ent|ant)\b)(?:[\s-]+[a-z][a-z'-]{1,20})?[\s-]+$/i;

const COMPOUND_AFTER = new RegExp(`^\\s+${DELIVERABLE_NOUN.source}`, "i");

export function buildOffer(
  capture: CaptureResult,
  ctas: CtaEntry[],
  pricing: PricingSection,
  guarantees: GuaranteesSection,
): OfferSection {
  const record = capture.record;
  const snapshot = capture.snapshot;
  const wordCount = countWords(snapshot.visible_text);

  const headlines = snapshot.headings
    .filter((heading) => heading.visible && heading.level <= 2)
    .map((heading) => heading.text);
  const aboveFoldCopy = snapshot.paragraphs
    .filter((paragraph) => paragraph.visible && paragraph.position === "above_fold")
    .map((paragraph) => paragraph.text);
  const allCopy = [...headlines, ...snapshot.paragraphs.filter((p) => p.visible).map((p) => p.text)];

  // Deliverables are read as a run down the page, so the blocks must be in
  // document order — headings and paragraphs interleaved, not concatenated.
  const orderedCopy: CopyBlock[] = [
    ...snapshot.headings.filter((h) => h.visible).map((h) => ({ text: h.text, y: h.y, heading: true })),
    ...snapshot.paragraphs.filter((p) => p.visible).map((p) => ({ text: p.text, y: p.y, heading: false })),
  ].sort((a, b) => a.y - b.y);

  const primaryCta = ctas.find((cta) => cta.is_primary) ?? null;

  const benefits = unique(record.benefit_stack.map((item) => clamp(item.text))).slice(0, MAX_LIST);
  const deliverables = extractDeliverables(orderedCopy);

  const product = detectProduct(productSources(snapshot, aboveFoldCopy), primaryCta);
  const audience = detectAudience(allCopy);
  const mechanism = detectMechanism(allCopy);

  const guaranteeSentence = guarantees.items[0]?.text ?? null;

  return {
    product,
    audience,
    mechanism,
    benefits,
    deliverables,
    bonuses: record.attendance_bonuses.map((bonus) => ({ text: clamp(bonus.text), kind: bonus.kind })),
    // Only a parsed amount is a price point. The record's text is the whole
    // block the price was read from, which is not a price.
    price_points: unique(
      pricing.items.map((item) => item.amount).filter((amount): amount is string => Boolean(amount)),
    ).slice(0, MAX_LIST),
    discounts: unique(
      pricing.items
        .map((item) => item.discount)
        .filter((value): value is string => Boolean(value)),
    ).slice(0, MAX_LIST),
    guarantee_present: guarantees.detected,
    risk_reversal: guaranteeSentence
      ? detected(guaranteeSentence, 0.85, [`guarantee wording on the page: "${guaranteeSentence}"`])
      : unknown("No guarantee or risk-reversal language was detected"),
    cta_relationship: {
      primary_cta_text: primaryCta?.text ?? null,
      stated_outcome: primaryCta?.stated_outcome ?? null,
      supporting_copy: primaryCta?.supporting_copy ?? null,
    },
    clarity: assessClarity({
      wordCount,
      product,
      audience,
      benefits,
      primaryCta,
      pricing,
      proofCount: record.testimonials.length + record.social_proof.length,
    }),
  };
}

/**
 * The product is what the page leads with, so only the H1 and the copy a
 * visitor sees before scrolling are searched. A noun further down — a footer
 * heading, a nav word, the blog teaser — describes some other part of the site.
 */
function productSources(snapshot: DomSnapshot, aboveFoldCopy: string[]): ProductSource[] {
  const sources: ProductSource[] = [];
  for (const heading of snapshot.headings) {
    if (!heading.visible) continue;
    if (heading.level === 1) {
      sources.push({ text: heading.text, label: "the H1 names a deliverable", confidence: 0.7 });
    } else if (heading.level <= 3 && heading.position === "above_fold") {
      sources.push({
        text: heading.text,
        label: "an above-the-fold heading names a deliverable",
        confidence: 0.6,
      });
    }
  }
  for (const text of aboveFoldCopy) {
    sources.push({ text, label: "above-the-fold copy names a deliverable", confidence: 0.6 });
  }
  return sources;
}

function detectProduct(sources: ProductSource[], primaryCta: CtaEntry | null): Determination<string> {
  for (const source of sources) {
    const noun = qualifiedNoun(source.text);
    if (noun) {
      return detected(noun, source.confidence, [`${source.label}: "${clamp(source.text)}"`]);
    }
  }

  // A CTA can name the product when the copy above it does not, but a button
  // label is the weakest of the three placements.
  if (primaryCta) {
    const noun = qualifiedNoun(primaryCta.text);
    if (noun) {
      return detected(noun, 0.5, [`primary CTA names a deliverable: "${primaryCta.text}"`]);
    }
  }

  return unknown("No headline, above-the-fold copy or CTA names a specific product or deliverable");
}

/** The first deliverable noun that sits inside a phrase. See QUALIFIER_BEFORE. */
function qualifiedNoun(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  const scan = new RegExp(DELIVERABLE_NOUN.source, "gi");
  for (const match of line.matchAll(scan)) {
    const index = match.index ?? 0;
    const after = line.slice(index + match[0].length);
    const compound = COMPOUND_AFTER.exec(after);
    if (compound) return `${match[0]} ${compound[0].trim()}`.toLowerCase();
    if (QUALIFIER_BEFORE.test(line.slice(0, index))) return match[0].toLowerCase();
  }
  return null;
}

function detectAudience(copy: string[]): Determination<string> {
  for (const line of copy) {
    for (const pattern of AUDIENCE_PATTERNS) {
      const match = line.match(pattern);
      const value = match?.[1]?.replace(/\s+/g, " ").trim();
      if (value && value.length >= 3 && value.length <= 80) {
        return detected(value, 0.7, [`explicit audience statement: "${clamp(line)}"`]);
      }
    }
  }
  return unknown("No explicit audience statement was found in the copy");
}

function detectMechanism(copy: string[]): Determination<string> {
  for (const line of copy) {
    for (const pattern of MECHANISM_PATTERNS) {
      const match = line.match(pattern);
      const value = match?.[1]?.replace(/\s+/g, " ").trim();
      if (value && value.length >= 3 && value.length <= 80) {
        return detected(value, 0.65, [`named method or system: "${clamp(line)}"`]);
      }
    }
  }
  return unknown("The page does not name a method, system or framework");
}

/**
 * The blocks that follow a "what you get" lead, for as long as they still read
 * like one list. The run is bounded and ends at the first block that reads like
 * the next section, because a lead phrase says nothing about how far the list
 * runs: without a stop condition the rest of the page — the guarantee, the
 * footer, the section after it — is reported as things the buyer receives.
 */
function extractDeliverables(blocks: CopyBlock[]): string[] {
  const found: string[] = [];
  let capturing = false;
  let run = 0;
  let lastY = 0;

  for (const block of blocks) {
    const trimmed = block.text.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;

    // A second lead opens a new list rather than extending the current one.
    if (DELIVERABLE_LEAD.test(trimmed)) {
      capturing = true;
      run = 0;
      lastY = block.y;
      if (trimmed.length > 25 && looksLikeItem(trimmed)) found.push(clamp(trimmed));
      continue;
    }

    if (!capturing) continue;

    const newSection = block.heading || block.y - lastY > RUN_GAP_PX;
    if (newSection || run >= MAX_DELIVERABLE_RUN || !looksLikeItem(trimmed)) {
      capturing = false;
      continue;
    }

    found.push(clamp(trimmed));
    run += 1;
    lastY = block.y;
    if (found.length >= MAX_LIST) break;
  }

  return unique(found).slice(0, MAX_LIST);
}

/**
 * List items are short and self-contained. Sentence punctuation with more text
 * behind it is prose, which is how unrelated paragraphs got in.
 */
function looksLikeItem(text: string): boolean {
  if (text.length < ITEM_MIN_CHARS || text.length > ITEM_MAX_CHARS) return false;
  if (/[.!?]\s+\S/.test(text)) return false;
  return countWords(text) <= ITEM_MAX_WORDS;
}

function assessClarity(input: {
  wordCount: number;
  product: Determination<string>;
  audience: Determination<string>;
  benefits: string[];
  primaryCta: CtaEntry | null;
  pricing: PricingSection;
  proofCount: number;
}): OfferSection["clarity"] {
  if (input.wordCount < MIN_WORDS_FOR_CLARITY) {
    return unknown(`The page carries only ${input.wordCount} words of visible copy`);
  }

  const missing: string[] = [];
  if (input.product.status !== "detected") missing.push("product");
  if (input.audience.status !== "detected") missing.push("audience");
  if (!input.pricing.detected) missing.push("price");
  if (input.proofCount === 0) missing.push("proof");
  if (!input.primaryCta) missing.push("cta");

  const clear =
    input.product.status === "detected" &&
    Boolean(input.primaryCta) &&
    (input.audience.status === "detected" || input.benefits.length > 0);

  const evidence = [
    input.product.status === "detected" ? `product: ${input.product.value}` : "product could not be established",
    input.primaryCta ? `primary CTA: "${input.primaryCta.text}"` : "no primary CTA was detected",
    input.audience.status === "detected"
      ? `audience: ${input.audience.value}`
      : `${input.benefits.length} benefit statement(s) detected`,
  ];

  return detected({ clarity: clear ? "clear" : "unclear", missing }, clear ? 0.7 : 0.6, evidence);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function clamp(text: string, limit = TEXT_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}
