import type { CaptureResult } from "../../pipeline/capture.js";
import type { UrgencySection } from "../landing_types.js";

const MAX_ITEMS = 15;
const TEXT_CHARS = 240;

/** A timer element only counts when its text actually reads like a clock. */
const TIMER_TEXT = /\d{1,2}\s*:\s*\d{2}|\b\d{1,3}\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i;
const TIMER_VALUE = /\d{1,3}\s*:\s*\d{2}(?:\s*:\s*\d{2})?|\b\d{1,3}\s*(?:days?|hrs?|hours?|mins?|minutes?)\b/i;

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";

/** "Closes Friday" is a deadline; "Friday newsletter" is not. */
const CLOSING_VERB =
  /\b(?:doors?\s+close|closes?|closing|ends?|ending|expires?|expiring|deadline|last day|final day|registration closes|cart closes|applications? close)\b/i;
const DATE_TEXT = new RegExp(
  `\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b|\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b|\\b(?:${WEEKDAYS})\\b|\\b(?:midnight|noon|tonight|today|tomorrow)\\b`,
  "i",
);

/**
 * Only a calendar date names a day a visitor could check. "Closes Friday" or
 * "ends tonight" is relative wording that any page can carry on any day, so it
 * stays a deadline but never upgrades the evidence to "explicit".
 */
const CONCRETE_DATE = new RegExp(
  `\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b|\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b`,
  "i",
);

/** A counted claim states a number ("8 spots left"); "bonus ends soon" does not. */
const COUNTED = /\b\d{1,4}\b/;

const SCARCITY: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "limited_spots",
    re: /\b(?:only\s+)?\d{1,4}\s+(?:spots?|seats?|places?|slots?|spaces?|licen[cs]es?|copies)\s+(?:left|remaining|available)\b|\b(?:only\s+)?\d{1,4}\s+(?:spots?|seats?|places?)\s+(?:left|remain)\b|\blimited to \d{1,4}\b/i,
  },
  {
    kind: "limited_time",
    re: /\b(?:today only|last chance|final hours?|ends (?:today|tonight|tomorrow|soon)|closing (?:today|tonight|soon)|24 hours? only|this week only)\b/i,
  },
  {
    kind: "limited_bonus",
    re: /\b(?:bonus(?:es)? (?:expires?|ends?|disappears?)|first \d{1,4} (?:people|buyers|customers|sign[- ]?ups|students)|fast[- ]action bonus)\b/i,
  },
];

export function buildUrgency(capture: CaptureResult): UrgencySection {
  const snapshot = capture.snapshot;

  const countdownTimers = (snapshot.timers ?? [])
    .filter((timer) => TIMER_TEXT.test(timer.text))
    .slice(0, MAX_ITEMS)
    .map((timer) => ({
      text: clamp(timer.text),
      value: timer.text.match(TIMER_VALUE)?.[0]?.trim() ?? null,
      selector: timer.selector,
      visible: timer.visible,
    }));

  const blocks = [
    ...snapshot.headings.filter((heading) => heading.visible).map((heading) => heading.text),
    ...snapshot.paragraphs.filter((paragraph) => paragraph.visible).map((paragraph) => paragraph.text),
  ];

  const deadlines: UrgencySection["deadlines"] = [];
  const scarcityClaims: UrgencySection["scarcity_claims"] = [];
  const seenDeadline = new Set<string>();
  const seenScarcity = new Set<string>();

  for (const block of blocks) {
    for (const sentence of sentences(block)) {
      // A deadline needs both a closing verb and something date-like next to it.
      if (CLOSING_VERB.test(sentence) && DATE_TEXT.test(sentence)) {
        const key = sentence.toLowerCase();
        if (!seenDeadline.has(key) && deadlines.length < MAX_ITEMS) {
          seenDeadline.add(key);
          deadlines.push({
            text: clamp(sentence),
            date_text: sentence.match(DATE_TEXT)?.[0] ?? null,
          });
        }
      }

      const scarcity = SCARCITY.find(({ re }) => re.test(sentence));
      if (scarcity) {
        const key = `${scarcity.kind}:${sentence.toLowerCase()}`;
        if (!seenScarcity.has(key) && scarcityClaims.length < MAX_ITEMS) {
          seenScarcity.add(key);
          scarcityClaims.push({ text: clamp(sentence), kind: scarcity.kind });
        }
      }
    }
  }

  // "Explicit" means a visitor could check the claim: a clock they can see
  // running, a stated calendar date, or a counted quantity. Persuasive wording
  // alone never qualifies, and neither does a timer the page never shows —
  // a display:none widget or an unrendered template counts for nothing.
  const runningTimers = countdownTimers.filter((timer) => timer.visible);
  const hasCountedScarcity = scarcityClaims.some(
    (claim) =>
      (claim.kind === "limited_spots" || claim.kind === "limited_bonus") && COUNTED.test(claim.text),
  );
  const hasDatedDeadline = deadlines.some((deadline) => CONCRETE_DATE.test(deadline.text));
  const explicit = runningTimers.length > 0 || hasDatedDeadline || hasCountedScarcity;
  const anything = explicit || deadlines.length > 0 || scarcityClaims.length > 0;

  return {
    detected: anything,
    evidence_quality: explicit ? "explicit" : anything ? "language_only" : "none",
    countdown_timers: countdownTimers,
    deadlines,
    scarcity_claims: scarcityClaims,
  };
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[^a-z])|\s*[|•]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function clamp(text: string, limit = TEXT_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
