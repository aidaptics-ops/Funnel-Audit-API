import type { DomSnapshot, PricingRecord } from "../types/index.js";

const PRICE_RE =
  /(?:USD|CAD|AUD|GBP|EUR|\$|£|€)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|CAD|AUD|GBP|EUR)/g;

export function detectPricing(snapshot: DomSnapshot): PricingRecord[] {
  const records: PricingRecord[] = [];
  const seen = new Set<string>();

  const consider = (text: string, y: number, visible: boolean, position: PricingRecord["position"]) => {
    const matches = text.match(PRICE_RE) || [];
    for (const amount of matches) {
      const key = `${amount}|${text.slice(0, 40)}`;
      if (seen.has(key)) continue;
      if (isLikelyNonPrice(text, amount)) continue;
      seen.add(key);
      const original = text.match(
        /(?:was|normally|regularly|original(?:ly)?)\s*((?:USD|\$|£|€)\s?\d[\d,]*(?:\.\d{2})?)/i,
      );
      records.push({
        text: text.slice(0, 240),
        amount,
        currency: currencyOf(amount),
        original_price: original?.[1] || null,
        visible,
        position,
        context: text.slice(0, 240),
      });
    }
  };

  for (const heading of snapshot.headings) {
    consider(heading.text, heading.y, heading.visible, heading.position);
  }
  for (const p of snapshot.paragraphs) {
    consider(p.text, p.y, p.visible, p.position);
  }
  for (const btn of snapshot.buttons) {
    consider(btn.text, btn.y, btn.visible, btn.position);
  }

  return records.slice(0, 40);
}

function currencyOf(amount: string): string | null {
  if (amount.includes("$") || /USD/i.test(amount)) return "USD";
  if (amount.includes("£") || /GBP/i.test(amount)) return "GBP";
  if (amount.includes("€") || /EUR/i.test(amount)) return "EUR";
  return null;
}

function isLikelyNonPrice(text: string, amount: string): boolean {
  if (/copyright|©|\b19\d{2}\b|\b20\d{2}\b/.test(text) && !/\$/.test(amount)) return true;
  const num = Number(amount.replace(/[^\d.]/g, ""));
  if (num > 0 && num < 2 && !/[.]\d{2}/.test(amount)) return true;
  return false;
}
