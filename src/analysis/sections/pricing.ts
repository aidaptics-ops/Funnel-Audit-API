import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, PricingRecord } from "../../types/index.js";
import type { PriceEntry, PricingSection } from "../landing_types.js";

const MAX_ITEMS = 40;
const CONTEXT_CHARS = 240;

/** How far from the amount a modifier can sit and still describe that amount. */
const NEAR_PRICE_CHARS = 60;

/** A CTA further from the price than this is somewhere else on the page. */
const MAX_CTA_DISTANCE_PX = 600;

const RECURRING_RE =
  /(\/\s*(?:mo|mon|month|yr|year|wk|week)\b)|\bper\s+(?:month|year|week|day|mo|yr)\b|\b(?:monthly|yearly|annually|annual|weekly|recurring|subscription)\b|\ba\s+(?:month|year|week)\b/i;

const PAYMENT_PLAN_RE =
  /\b\d{1,2}\s*(?:monthly\s+|easy\s+|simple\s+)?payments?\s+of\b|\b\d{1,2}\s*[x×]\s*(?=[$£€]|\d)|\bpay\s+in\s+\d{1,2}\b|\b\d{1,2}\s+instal?lments?\b/i;

const DISCOUNT_RE = /\b(\d{1,3}\s*%\s*(?:off|discount)|save\s+(?:up\s+to\s+)?[$£€]?\d[\d,]*(?:\.\d{2})?)\b/i;

const CURRENCY_CODE_RE = /\b(USD|CAD|AUD|GBP|EUR|NZD|CHF|SEK|INR)\b/i;

export function buildPricing(capture: CaptureResult): PricingSection {
  const records = capture.record.pricing.slice(0, MAX_ITEMS);
  const items: PriceEntry[] = records.map((record) => toEntry(record));

  const currencies = new Set(items.map((item) => item.currency).filter((c): c is string => c !== null));
  const priced = items.filter((item) => item.numeric_amount !== null);
  const sorted = [...priced].sort((a, b) => (a.numeric_amount as number) - (b.numeric_amount as number));

  const paymentPlans: string[] = [];
  const seenPlans = new Set<string>();
  for (const item of items) {
    if (!item.payment_plan) continue;
    const key = item.payment_plan.toLowerCase();
    if (seenPlans.has(key)) continue;
    seenPlans.add(key);
    paymentPlans.push(item.payment_plan);
  }

  return {
    detected: items.length > 0,
    // A page that mixes currencies has no single dominant one to report.
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    items,
    lowest: sorted.length ? priceLabel(sorted[0]!) : null,
    highest: sorted.length ? priceLabel(sorted[sorted.length - 1]!) : null,
    payment_plans: paymentPlans,
    pricing_cta: nearestCta(capture, records),
  };
}

function toEntry(record: PricingRecord): PriceEntry {
  const context = record.context ?? record.text;
  const near = nearPriceText(record, context);
  return {
    text: record.text,
    amount: record.amount,
    numeric_amount: parseAmount(record.amount),
    currency: currencyOf(record),
    original_price: record.original_price,
    discount: near.match(DISCOUNT_RE)?.[0]?.trim() ?? null,
    recurring: RECURRING_RE.test(near),
    payment_plan: near.match(PAYMENT_PLAN_RE)?.[0]?.trim() ?? null,
    position: record.position,
    context: context ? context.slice(0, CONTEXT_CHARS) : null,
  };
}

/**
 * The window around the amount itself. "Monthly" further down the same block
 * belongs to some other price or to prose about the offer; reading it as this
 * price's billing period turns a one-off fee into a subscription.
 */
function nearPriceText(record: PricingRecord, context: string): string {
  const windows: string[] = [];
  for (const source of new Set([record.text, context])) {
    if (!source) continue;
    const index = record.amount ? source.indexOf(record.amount) : -1;
    if (index === -1) {
      // With no anchor to measure from, only a block short enough to be all
      // "near the price" can be used at all.
      if (source.length <= NEAR_PRICE_CHARS * 2) windows.push(source);
      continue;
    }
    const end = index + (record.amount?.length ?? 0);
    // A modifier that describes this price sits in the same sentence as it;
    // the character window then caps a very long sentence.
    const start = Math.max(sentenceStart(source, index), index - NEAR_PRICE_CHARS);
    const stop = Math.min(sentenceEnd(source, end), end + NEAR_PRICE_CHARS);
    windows.push(source.slice(start, stop));
  }
  return windows.join(" ");
}

/** Sentence and list-item boundaries; a price never spans one. */
const BREAKS = [".", "!", "?", ";", "•", "|", "\n"];

function sentenceStart(text: string, index: number): number {
  let start = 0;
  for (const brk of BREAKS) {
    const at = text.lastIndexOf(brk, index);
    if (at >= 0 && at + 1 > start) start = at + 1;
  }
  return start;
}

function sentenceEnd(text: string, from: number): number {
  let end = text.length;
  for (const brk of BREAKS) {
    const at = text.indexOf(brk, from);
    if (at >= 0 && at < end) end = at;
  }
  return end;
}

/**
 * "1.234,56" and "1,234.56" are the same amount written under two conventions,
 * and reading one as the other is wrong by a factor of a thousand. Where the
 * separators settle the convention the value is parsed; where they do not, the
 * amount stays unknown instead of being guessed.
 */
function parseAmount(amount: string | null): number | null {
  if (!amount) return null;
  const raw = amount.replace(/[^\d.,]/g, "");
  if (!/^\d[\d.,]*\d$|^\d$/.test(raw)) return null;

  const commas = (raw.match(/,/g) ?? []).length;
  const dots = (raw.match(/\./g) ?? []).length;

  if (commas > 0 && dots > 0) {
    // The rightmost separator is the decimal point; the other groups thousands.
    const decimal = raw.lastIndexOf(",") > raw.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    const parts = raw.split(decimal);
    if (parts.length !== 2) return null;
    const whole = parts[0]!.split(thousands);
    if (!groupsValid(whole)) return null;
    return toNumber(`${whole.join("")}.${parts[1]!}`);
  }

  if (commas === 0 && dots === 0) return toNumber(raw);

  const separator = commas > 0 ? "," : ".";
  const parts = raw.split(separator);
  const tail = parts[parts.length - 1]!;

  // Repeated separators can only be thousands grouping in either convention.
  if (parts.length > 2) return groupsValid(parts) ? toNumber(parts.join("")) : null;

  if (tail.length === 3) {
    // A three-digit group is a thousands group under one convention and a
    // three-decimal fraction under the other. A comma is safe: no locale
    // writes a fractional price with three digits after a decimal comma. A
    // dot is not — "1.500" is either 1500 or one and a half — unless the
    // leading zero forces it ("0.500").
    if (separator === ",") return groupsValid(parts) ? toNumber(parts.join("")) : null;
    if (/^0$/.test(parts[0]!)) return toNumber(raw);
    return null;
  }

  // One or two digits after the separator is a decimal fraction either way;
  // four or more is neither a valid group nor a price fraction.
  if (tail.length === 0 || tail.length > 3) return null;
  return toNumber(`${parts[0]!}.${tail}`);
}

/** A thousands-grouped whole part: 1-3 digits, then groups of exactly 3. */
function groupsValid(parts: string[]): boolean {
  if (!parts.length) return false;
  if (!/^\d{1,3}$/.test(parts[0]!)) return false;
  return parts.slice(1).every((part) => /^\d{3}$/.test(part));
}

function toNumber(text: string): number | null {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

/** An explicit code beats a symbol: "CAD $49" is CAD, not USD. */
function currencyOf(record: PricingRecord): string | null {
  const code = (record.amount ?? "").match(CURRENCY_CODE_RE) ?? (record.text || "").match(CURRENCY_CODE_RE);
  if (code) return code[1]!.toUpperCase();
  if (record.currency) return record.currency;
  const amount = record.amount ?? "";
  if (amount.includes("£")) return "GBP";
  if (amount.includes("€")) return "EUR";
  return null;
}

function priceLabel(entry: PriceEntry): string {
  return entry.amount ?? entry.text;
}

/**
 * Price records carry no y of their own, so each one is matched back to the
 * snapshot block it was read from; a price we cannot place is not measured.
 */
function nearestCta(capture: CaptureResult, records: PricingRecord[]): string | null {
  const ctas = capture.record.ctas;
  if (!records.length || !ctas.length) return null;

  const yByText = indexBlockY(capture.snapshot);
  let best: { text: string; distance: number } | null = null;

  for (const record of records) {
    const priceY = yByText.get(record.text);
    if (priceY === undefined) continue;
    for (const cta of ctas) {
      const distance = Math.abs(cta.y - priceY);
      // A CTA most of a screen away from every price is not the pricing CTA;
      // reporting the nearest one regardless would name a button that has
      // nothing to do with the price.
      if (distance > MAX_CTA_DISTANCE_PX) continue;
      if (best === null || distance < best.distance) {
        best = { text: cta.text.trim(), distance };
      }
    }
  }

  return best?.text ?? null;
}

function indexBlockY(snapshot: DomSnapshot): Map<string, number> {
  const map = new Map<string, number>();
  const add = (text: string, y: number) => {
    // The pricing detector stores the source text sliced to 240 chars.
    const key = text.slice(0, 240);
    if (!map.has(key)) map.set(key, y);
  };
  for (const heading of snapshot.headings) add(heading.text, heading.y);
  for (const paragraph of snapshot.paragraphs) add(paragraph.text, paragraph.y);
  for (const button of snapshot.buttons) add(button.text, button.y);
  return map;
}
