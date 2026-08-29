import type { CaptureResult } from "../../pipeline/capture.js";
import type { FoldPosition } from "../../types/index.js";
import type { GuaranteeEntry, GuaranteesSection } from "../landing_types.js";

const MAX_ITEMS = 20;
const TEXT_CHARS = 240;

/**
 * Ordered: the first pattern that matches a sentence wins, so a "30-day
 * money-back guarantee, completely risk-free" line is reported as money_back
 * rather than as the weaker "other" bucket.
 */
const KINDS: Array<{ kind: GuaranteeEntry["kind"]; re: RegExp }> = [
  { kind: "money_back", re: /\b(money[-\s]?back|full refund|refunds?)\b/i },
  {
    kind: "results",
    re: /\b(guaranteed results|results (?:are )?guaranteed|we guarantee (?:you|that|your))\b/i,
  },
  {
    kind: "satisfaction",
    re: /\b(satisfaction (?:is )?guarantee[ds]?|guaranteed satisfaction|100% satisfaction|love it or)\b/i,
  },
  {
    kind: "free_trial",
    re: /\b(free trial|try it free|try [^.]{0,20} for free|no credit card(?: required| needed)?)\b/i,
  },
  { kind: "other", re: /\b(risk[-\s]?free|no risk|cancel any\s?time)\b/i },
];

const DURATION_RE =
  /\b(\d{1,3}|one|two|three|four|five|six|seven|ten|twelve|fourteen|thirty|sixty|ninety)[-\s]?(day|days|week|weeks|month|months|year|years)\b/i;

/** A bare footer label such as "Refund Policy" is a link title, not a promise. */
const POLICY_LABEL_RE = /^(refund|return|cancellation)s?\s+(policy|policies)$/i;

/**
 * A pointer at a policy document ("see our refund policy") promises nothing on
 * its own. It only counts once the same sentence also states the promise —
 * "guarantee"/"money-back" wording or a stated duration.
 */
const POLICY_REFERENCE_RE = /\b(?:refund|return|cancellation)s?\s+polic(?:y|ies)\b/i;
const PROMISE_RE = /\b(?:guarantee[ds]?|money[-\s]?back)\b/i;

/**
 * Negated guarantee wording states the opposite of a guarantee, and the KINDS
 * patterns match it word for word: "no refunds", "we do not offer refunds",
 * "all sales are final" and "non-refundable" all contain the money_back
 * trigger. Reporting any of them as a guarantee inverts the truth of the page,
 * so a negated sentence is dropped rather than downgraded.
 */
const NEGATED_PHRASE_RE =
  /\ball\s+sales\s+(?:are\s+)?final\b|\bnon[-\s]?refundable\b|\bnot\s+refundable\b|\bno\s+refunds?\b|\bno\s+money[-\s]?back\b|\bwithout\s+(?:a\s+)?(?:refund|guarantee)\b/i;

/** A negator in the few words immediately before the trigger negates it. */
const NEGATOR_BEFORE_RE =
  /\b(?:no|not|never|none|without|cannot|can(?:'|’)t|do(?:n(?:'|’)t|es\s?n(?:'|’)t)|won(?:'|’)t|isn(?:'|’)t|aren(?:'|’)t)\b[^.!?]{0,24}$/i;

/** "…guarantee is not available": the trigger itself is being denied. */
const NEGATOR_AFTER_RE = /^[^.!?]{0,24}\b(?:is|are|was|were)\s+(?:not|never|no longer)\b/i;

export function buildGuarantees(capture: CaptureResult): GuaranteesSection {
  const snapshot = capture.snapshot;
  const blocks: Array<{ text: string; position: FoldPosition }> = [
    ...snapshot.headings.filter((h) => h.visible).map((h) => ({ text: h.text, position: h.position })),
    ...snapshot.paragraphs.filter((p) => p.visible).map((p) => ({ text: p.text, position: p.position })),
  ];

  const items: GuaranteeEntry[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    for (const sentence of sentences(block.text)) {
      if (POLICY_LABEL_RE.test(sentence)) continue;
      const match = KINDS.find(({ re }) => re.test(sentence));
      if (!match) continue;
      if (isNegated(sentence, match.re)) continue;
      if (POLICY_REFERENCE_RE.test(sentence) && !PROMISE_RE.test(sentence) && !DURATION_RE.test(sentence)) {
        continue;
      }

      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        text: clamp(sentence),
        kind: match.kind,
        duration: sentence.match(DURATION_RE)?.[0] ?? null,
        position: block.position,
      });
      if (items.length >= MAX_ITEMS) break;
    }
    if (items.length >= MAX_ITEMS) break;
  }

  return {
    detected: items.length > 0,
    items,
    risk_reversal_present: items.length > 0,
  };
}

/**
 * Note for tests: "No refunds", "no refunds are offered", "we do not offer
 * refunds", "all sales are final" and "non-refundable" must all return true —
 * each one matches a KINDS pattern but promises the opposite of a guarantee.
 * Wording that legitimately opens with a negation ("no risk", "no credit card
 * required") is not negated, because the negator is part of the trigger itself
 * and so never sits before it.
 */
function isNegated(sentence: string, trigger: RegExp): boolean {
  if (NEGATED_PHRASE_RE.test(sentence)) return true;
  const match = trigger.exec(sentence);
  if (!match) return false;
  const index = match.index;
  const before = sentence.slice(0, index);
  const after = sentence.slice(index + match[0].length);
  return NEGATOR_BEFORE_RE.test(before) || NEGATOR_AFTER_RE.test(after);
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[^a-z])|\s*[|•]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function clamp(text: string, limit = TEXT_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
