import type {
  BenefitStackItem,
  BonusRecord,
  CtaBenefitRelationship,
  CtaRecord,
  DomSnapshot,
  FaqSection,
  FormRecord,
  ObjectionRecord,
  OtoEvidence,
  PageType,
  PricingRecord,
  ProofPlacementRecord,
  TestimonialRecord,
  UrgencyRecord,
  VideoRecord,
} from "../types/index.js";

const BENEFIT_HEADINGS =
  /\b(what (you('ll| will) )?(learn|get|discover)|you('ll| will) (learn|discover|walk away)|benefits?|outcomes?|takeaways?|curriculum|agenda|what('s| is) inside|reasons? to (attend|join|register)|here('s| is) what)\b/i;

const OBJECTION_TOPICS: Array<{ topic: string; re: RegExp }> = [
  { topic: "price", re: /\b(too expensive|can'?t afford|is it expensive|worth the (price|investment)|price too high)\b/i },
  { topic: "price_mention", re: /\b(price|cost|investment|budget|afford)\b/i },
  { topic: "trust", re: /\b(money[- ]back|risk[- ]free|refund guarantee|is this legit|is this a scam)\b/i },
  { topic: "credibility", re: /\b(as seen (in|on)|featured (in|on)|years of experience)\b/i },
  { topic: "method_works", re: /\b(does this actually work|is this proven|results guaranteed)\b/i },
  { topic: "fit", re: /\b(is this for me|not for you if|even if you('ve| have))\b/i },
  { topic: "time", re: /\b(how much time|time commitment|no time to)\b/i },
  { topic: "competition", re: /\b(unlike others|different from|saturated market)\b/i },
  { topic: "legitimacy", re: /\b(not a (scam|get[- ]rich)|real people actually)\b/i },
  { topic: "risk", re: /\b(no risk|nothing to lose|money[- ]back)\b/i },
  { topic: "failed_attempts", re: /\b(tried everything|nothing worked|failed before|already tried)\b/i },
];

const BONUS_PATTERNS: Array<{ kind: BonusRecord["kind"]; re: RegExp }> = [
  { kind: "attendance", re: /\b(when you (show up|attend)|attendance bonus|show up and get|bonus.{0,40}attend)\b/i },
  { kind: "fast_action", re: /\b(fast[- ]action|first \d+|register now and (get|receive)|instant bonus)\b/i },
  { kind: "registration", re: /\b(when you register|bonus.{0,40}register|free gift when you (join|sign))\b/i },
  { kind: "bonus", re: /\bbonus(es)?\b/i },
];

export function detectBenefitStack(snapshot: DomSnapshot): BenefitStackItem[] {
  const items: BenefitStackItem[] = [];
  for (const heading of snapshot.headings) {
    if (!BENEFIT_HEADINGS.test(heading.text)) continue;
    const nextBoundary =
      snapshot.headings.find((h) => h.y > heading.y && h.level <= heading.level)?.y ?? heading.y + 800;
    const nearby = snapshot.paragraphs.filter(
      (p) => p.y >= heading.y && p.y < nextBoundary && p.text.length > 12,
    );
    const listLike = nearby.filter(
      (p) => p.text.length < 240 || /^[-•*]/.test(p.text) || /^\d+[\).]/.test(p.text),
    );
    const texts = (listLike.length ? listLike : nearby).slice(0, 12);
    if (!texts.length) {
      items.push({
        heading: heading.text,
        text: heading.text,
        kind: "heading_only",
        position: heading.position,
      });
      continue;
    }
    for (const p of texts) {
      items.push({
        heading: heading.text,
        text: p.text,
        kind: "benefit_or_takeaway",
        position: p.position,
      });
    }
  }
  return items;
}

export function detectObjections(snapshot: DomSnapshot): ObjectionRecord[] {
  const records: ObjectionRecord[] = [];
  const seen = new Set<string>();
  const blocks = [...snapshot.headings.map((h) => ({ ...h })), ...snapshot.paragraphs];
  for (const block of blocks) {
    for (const { topic, re } of OBJECTION_TOPICS) {
      if (!re.test(block.text)) continue;
      const key = `${topic}:${block.text.slice(0, 60)}`;
      if (seen.has(key)) continue;
      if (topic === "price_mention" && seen.has(`price:${block.text.slice(0, 60)}`)) continue;
      seen.add(key);
      records.push({
        topic,
        text: block.text.slice(0, 400),
        position: block.position,
      });
    }
  }
  return records;
}

export function detectBonuses(snapshot: DomSnapshot): BonusRecord[] {
  const records: BonusRecord[] = [];
  const seen = new Set<string>();
  const blocks = [...snapshot.headings, ...snapshot.paragraphs];
  for (const block of blocks) {
    for (const { kind, re } of BONUS_PATTERNS) {
      if (!re.test(block.text)) continue;
      const key = block.text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        text: block.text.slice(0, 400),
        kind,
        position: block.position,
      });
      break;
    }
  }
  return records;
}

export function detectOto(
  snapshot: DomSnapshot,
  pageType: PageType,
  pricing: PricingRecord[],
  ctas: CtaRecord[],
): OtoEvidence {
  const text = snapshot.visible_text.toLowerCase();
  const evidence: string[] = [];
  if (pageType === "one_time_offer") evidence.push("page classified as one_time_offer");
  if (/\bone[- ]time (offer|only)\b/.test(text)) evidence.push("one-time offer language");
  if (/\bwait[!.,]/.test(text)) evidence.push("'wait' interstitial language");
  if (/\b(yes[, ]i want|no thanks|no[, ](i('ll)? )?continue|skip this offer)\b/.test(text)) {
    evidence.push("yes/no offer choice language");
  }
  if (/\b(special offer|exclusive offer|order bump)\b/.test(text)) evidence.push("special/exclusive offer language");

  const yesNo = snapshot.buttons
    .map((b) => b.text)
    .filter((t) => /\b(yes|no thanks|no[, ]i|skip|continue without|i don't want)\b/i.test(t));

  const decline = snapshot.links.find((l) =>
    /\b(no thanks|decline|skip|continue without|not now)\b/i.test(l.text),
  );

  const countdown = snapshot.timers[0]?.text || null;
  const product =
    snapshot.headings.find((h) => h.level <= 2 && h.visible)?.text || null;

  return {
    detected: evidence.length > 0 || yesNo.length >= 1,
    product_name: evidence.length ? product : null,
    price: pricing[0]?.amount || null,
    original_price: pricing[0]?.original_price || null,
    discount: findDiscount(snapshot.visible_text),
    cta_text: ctas.find((c) => /\byes|add|buy|get|upgrade|claim/i.test(c.text))?.text || ctas[0]?.text || null,
    countdown,
    yes_no_options: yesNo.slice(0, 6),
    decline_link: decline?.href || decline?.text || null,
    evidence,
  };
}

export function ctaBenefitRelationships(ctas: CtaRecord[]): CtaBenefitRelationship[] {
  return ctas.slice(0, 20).map((cta) => ({
    cta_text: cta.text,
    supporting_copy: cta.supporting_copy,
    headline_above: cta.headline_above,
    stated_outcome: cta.stated_outcome,
    instructions: cta.supporting_copy,
  }));
}

export function detectProofPlacement(
  snapshot: DomSnapshot,
  testimonials: TestimonialRecord[],
  videos: VideoRecord[],
  ctas: CtaRecord[],
): ProofPlacementRecord[] {
  const heroY = snapshot.viewport.height;
  const firstCtaY = ctas[0]?.y ?? null;
  const firstVideoY = videos[0]
    ? videos[0].position === "above_fold"
      ? 0
      : heroY + 1
    : null;

  return testimonials.slice(0, 15).map((t) => {
    const relative: string[] = [];
    if (t.position === "above_fold") relative.push("first_scroll");
    else relative.push("below_first_scroll");
    if (t.y > snapshot.viewport.scroll_height * 0.75) relative.push("page_bottom");
    if (t.y < heroY) relative.push("hero");
    if (firstVideoY !== null) relative.push(t.y <= firstVideoY ? "before_or_at_vsl" : "after_vsl");
    if (firstCtaY !== null) relative.push(t.y <= firstCtaY ? "before_or_at_cta" : "after_cta");
    return {
      kind: t.format,
      text: t.text.slice(0, 180),
      position: t.position,
      relative_to: relative,
      y: t.y,
    };
  });
}

export function primaryApplicationFriction(forms: FormRecord[]): FormRecord["friction"] {
  const app = forms.find((f) => f.type === "application") || forms.sort((a, b) => b.field_count - a.field_count)[0];
  return app?.friction || null;
}

function findDiscount(text: string): string | null {
  const m = text.match(/\b(\d{1,3}%\s*off|save\s*\$?\d+|\d{1,3}%\s*discount)\b/i);
  return m ? m[0] : null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function sliceAround(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m || m.index == null) return null;
  return text.slice(Math.max(0, m.index - 20), m.index + 160).replace(/\s+/g, " ").trim();
}
