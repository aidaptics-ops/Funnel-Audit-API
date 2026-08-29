import type { CaptureResult } from "../../pipeline/capture.js";
import type { FaqItem, HeadingRecord, PricingRecord, TextBlock } from "../../types/index.js";
import type { CopySection } from "../landing_types.js";

const MAX_KEY_MESSAGES = 12;
const MAX_ABOVE_FOLD_COPY = 12;
const MAX_REPEATED_MESSAGES = 10;
const MAX_INCONSISTENCIES = 5;
const REPEATED_MIN_LENGTH = 15;
const ALL_CAPS_MIN_LENGTH = 8;
const LEAD_PARAGRAPH_MIN_LENGTH = 41;
/** Averages computed on a handful of words say nothing; report null instead. */
const MIN_WORDS_FOR_AVERAGES = 20;

type Inconsistency = CopySection["inconsistencies"][number];

const PRICE_TOKEN =
  /(?:USD|CAD|AUD|GBP|EUR|\$|£|€)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|CAD|AUD|GBP|EUR)/g;

/**
 * Wording that legitimately carries two prices at once (discounts, plans, tiers).
 * Contexts like these are skipped so a struck-through or per-plan price is never
 * reported as a contradiction.
 */
const MULTI_PRICE_CONTEXT =
  /\b(?:was|now|instead of|normally|regularly|original|originally|save|discount|off|from|starting|as low as|reg\.?|value|worth|per|month|monthly|year|yearly|annual|annually|mo|yr|installments?|payments?|deposit|plan|tier|package|billed|upgrade|add[- ]on)\b/i;

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_ALTERNATION = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
/**
 * Month-name dates only. Numeric forms such as 3/4/2026 are ambiguous between
 * day-first and month-first locales and would manufacture false contradictions.
 */
const DEADLINE_PATTERN = new RegExp(
  `\\b(ends?|closes?|closing|expires?|deadline(?:\\s+is)?)\\s+(?:on\\s+|at\\s+)?` +
    `((?:${MONTH_ALTERNATION})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?` +
    `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALTERNATION})(?:,?\\s*\\d{4})?)`,
  "gi",
);

export function buildCopy(capture: CaptureResult): CopySection {
  const snapshot = capture.snapshot;
  const text = snapshot.visible_text ?? "";
  const words = text.split(/\s+/).filter((word) => word.length > 0);

  return {
    word_count: words.length,
    character_count: text.length,
    paragraph_count: snapshot.paragraphs.length,
    language: snapshot.lang ?? capture.record.technical_snapshot?.language ?? null,
    measurements: {
      average_sentence_words: averageSentenceWords(text, words.length),
      average_word_characters: averageWordCharacters(words),
      all_caps_blocks: countAllCapsBlocks(snapshot.headings, snapshot.paragraphs),
      exclamation_marks: countOccurrences(text, "!"),
      question_marks: countOccurrences(text, "?"),
    },
    key_messages: keyMessages(snapshot.headings, snapshot.paragraphs),
    above_fold_copy: aboveFoldCopy(snapshot.headings, snapshot.paragraphs),
    repeated_messages: repeatedMessages(snapshot.headings, snapshot.paragraphs),
    benefit_statements: capture.record.benefit_stack,
    objection_handling: capture.record.objection_handling,
    faq: flattenFaq(capture),
    inconsistencies: findInconsistencies(capture),
  };
}

function averageSentenceWords(text: string, wordCount: number): number | null {
  if (wordCount < MIN_WORDS_FOR_AVERAGES) return null;
  const sentences = text
    .split(/[.!?]+(?=\s|$)/)
    .map((sentence) => sentence.split(/\s+/).filter((word) => word.length > 0).length)
    .filter((count) => count > 0);
  if (!sentences.length) return null;
  const total = sentences.reduce((sum, count) => sum + count, 0);
  return round1(total / sentences.length);
}

function averageWordCharacters(words: string[]): number | null {
  if (words.length < MIN_WORDS_FOR_AVERAGES) return null;
  const lengths = words
    .map((word) => word.replace(/[^\p{L}\p{N}'-]/gu, "").length)
    .filter((length) => length > 0);
  if (!lengths.length) return null;
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return round1(total / lengths.length);
}

function countAllCapsBlocks(headings: HeadingRecord[], paragraphs: TextBlock[]): number {
  const blocks = [...headings, ...paragraphs];
  let count = 0;
  for (const block of blocks) {
    if (!block.visible) continue;
    const value = block.text.trim();
    if (value.length < ALL_CAPS_MIN_LENGTH) continue;
    // Scripts without case (CJK, Arabic) equal their own upper-case form.
    if (!/[A-Za-z]/.test(value)) continue;
    if (value === value.toUpperCase()) count += 1;
  }
  return count;
}

function countOccurrences(text: string, character: string): number {
  let count = 0;
  for (const char of text) {
    if (char === character) count += 1;
  }
  return count;
}

function keyMessages(headings: HeadingRecord[], paragraphs: TextBlock[]): string[] {
  const topLevel = headings.filter((heading) => heading.level <= 2 && heading.visible);
  const candidates: string[] = [];

  for (const heading of headings) {
    if (heading.level === 1 && heading.visible) candidates.push(heading.text);
  }
  for (const heading of topLevel) {
    candidates.push(heading.text);
  }
  for (let index = 0; index < topLevel.length; index += 1) {
    const heading = topLevel[index];
    const boundary = topLevel[index + 1]?.y ?? Number.POSITIVE_INFINITY;
    const lead = paragraphs.find(
      (paragraph) =>
        paragraph.visible &&
        paragraph.y >= heading.y &&
        paragraph.y < boundary &&
        paragraph.text.trim().length >= LEAD_PARAGRAPH_MIN_LENGTH,
    );
    if (lead) candidates.push(lead.text);
  }

  return dedupe(candidates, MAX_KEY_MESSAGES);
}

function aboveFoldCopy(headings: HeadingRecord[], paragraphs: TextBlock[]): string[] {
  const blocks = [...headings, ...paragraphs]
    .filter((block) => block.visible && block.position === "above_fold")
    .sort((a, b) => a.y - b.y);
  return dedupe(
    blocks.map((block) => block.text),
    MAX_ABOVE_FOLD_COPY,
  );
}

function repeatedMessages(
  headings: HeadingRecord[],
  paragraphs: TextBlock[],
): { text: string; occurrences: number }[] {
  // Only visible blocks: responsive markup often duplicates a hidden copy of the
  // same text, which a visitor never sees repeated.
  const blocks = [...headings, ...paragraphs].filter((block) => block.visible);
  const groups = new Map<string, { text: string; occurrences: number; order: number }>();

  for (const block of blocks) {
    const key = normalize(block.text);
    if (key.length < REPEATED_MIN_LENGTH) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    groups.set(key, { text: trimTo160(block.text), occurrences: 1, order: groups.size });
  }

  return [...groups.values()]
    .filter((group) => group.occurrences >= 2)
    .sort((a, b) => b.occurrences - a.occurrences || a.order - b.order)
    .slice(0, MAX_REPEATED_MESSAGES)
    .map((group) => ({ text: group.text, occurrences: group.occurrences }));
}

function flattenFaq(capture: CaptureResult): FaqItem[] {
  const items: FaqItem[] = [];
  const seen = new Set<string>();
  for (const section of capture.record.faq_sections) {
    for (const item of section.items) {
      const key = normalize(item.question);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
}

function findInconsistencies(capture: CaptureResult): Inconsistency[] {
  const found = [
    ...conflictingPrices(capture.record.pricing),
    ...conflictingDeadlines(capture.snapshot.visible_text ?? ""),
  ];
  return found.slice(0, MAX_INCONSISTENCIES);
}

/** Same offer wording, two different explicit prices. */
function conflictingPrices(pricing: PricingRecord[]): Inconsistency[] {
  const groups = new Map<string, PricingRecord[]>();

  for (const record of pricing) {
    if (!record.amount) continue;
    if (record.original_price) continue;
    const context = collapse(record.context ?? record.text ?? "");
    if (!context || MULTI_PRICE_CONTEXT.test(context)) continue;
    const wording = normalize(context.replace(PRICE_TOKEN, " "));
    if (wording.length < 12) continue;
    const bucket = groups.get(wording);
    if (bucket) bucket.push(record);
    else groups.set(wording, [record]);
  }

  const results: Inconsistency[] = [];
  for (const [wording, records] of groups) {
    const byAmount = new Map<string, PricingRecord>();
    for (const record of records) {
      const key = amountKey(record);
      if (key && !byAmount.has(key)) byAmount.set(key, record);
    }
    if (byAmount.size < 2) continue;

    const distinctTexts = new Set(records.map((record) => collapse(record.text)));
    // Two amounts inside one block ("was $497, now $97") are not a contradiction.
    if (distinctTexts.size < 2) continue;

    const [first, second] = [...byAmount.values()];
    if (collapse(first.text) === collapse(second.text)) continue;
    results.push({
      kind: "conflicting_price",
      detail: `Two different prices appear with the same offer wording ("${wording}"): ${first.amount} and ${second.amount}.`,
      evidence: [`"${trimTo160(first.text)}"`, `"${trimTo160(second.text)}"`],
    });
  }

  return results;
}

/** The same stated deadline resolving to two different calendar dates. */
function conflictingDeadlines(text: string): Inconsistency[] {
  const groups = new Map<
    string,
    { date: string; year: string | null; evidence: string; index: number }[]
  >();

  DEADLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = DEADLINE_PATTERN.exec(text);
  while (match) {
    const parsed = parseDate(match[2]);
    if (parsed) {
      const verb = normalizeVerb(match[1]);
      const subject = precedingWord(text, match.index);
      const key = `${subject}|${verb}`;
      const entry = {
        date: parsed.date,
        year: parsed.year,
        evidence: contextWindow(text, match.index, match[0].length),
        index: match.index,
      };
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }
    match = DEADLINE_PATTERN.exec(text);
  }

  const results: Inconsistency[] = [];
  for (const entries of groups.values()) {
    const first = entries[0];
    const conflict = entries.find(
      (entry) =>
        entry.date !== first.date ||
        (entry.year !== null && first.year !== null && entry.year !== first.year),
    );
    if (!conflict) continue;
    results.push({
      kind: "conflicting_deadline",
      detail: `The same deadline is stated as two different dates: ${first.date}${
        first.year ? ` ${first.year}` : ""
      } and ${conflict.date}${conflict.year ? ` ${conflict.year}` : ""}.`,
      evidence: [`"${trimTo160(first.evidence)}"`, `"${trimTo160(conflict.evidence)}"`],
    });
  }

  return results;
}

function parseDate(raw: string): { date: string; year: string | null } | null {
  const value = raw.toLowerCase().replace(/,/g, " ");
  const monthFirst = value.match(
    new RegExp(`^(${MONTH_ALTERNATION})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?$`),
  );
  const dayFirst = value.match(
    new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})(?:\\s+(\\d{4}))?$`),
  );
  const parts = monthFirst
    ? { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] }
    : dayFirst
      ? { month: dayFirst[2], day: dayFirst[1], year: dayFirst[3] }
      : null;
  if (!parts) return null;
  const month = MONTHS[parts.month];
  if (!month) return null;
  const day = Number(parts.day);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return { date: `${month}-${day}`, year: parts.year ?? null };
}

function normalizeVerb(verb: string): string {
  const value = verb.toLowerCase().replace(/\s+/g, " ").trim();
  if (value.startsWith("deadline")) return "deadline";
  if (value.startsWith("clos")) return "close";
  if (value.startsWith("expir")) return "expire";
  return "end";
}

/**
 * The word immediately before the deadline verb keeps "registration ends" and
 * "sale ends" in separate buckets: different subjects, not a contradiction.
 */
function precedingWord(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 40), index);
  const segment = before.split(/[.!?\n|•·]/).pop() ?? "";
  const words = segment.toLowerCase().match(/[a-z']+/g);
  return words?.length ? words[words.length - 1] : "";
}

function contextWindow(text: string, index: number, length: number): string {
  return collapse(text.slice(Math.max(0, index - 60), index + length + 60));
}

function amountKey(record: PricingRecord): string | null {
  const digits = (record.amount ?? "").replace(/[^\d.]/g, "");
  const value = Number(digits);
  if (!Number.isFinite(value) || !digits) return null;
  return `${record.currency ?? ""}:${value}`;
}

function dedupe(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function normalize(value: string): string {
  return collapse(value)
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function collapse(value: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function trimTo160(value: string): string {
  const text = collapse(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
