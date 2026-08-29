import type { DomSnapshot, UrgencyRecord } from "../types/index.js";

const PATTERNS: Array<{ kind: string; re: RegExp; concrete: boolean }> = [
  { kind: "countdown_timer", re: /\b\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}\b/, concrete: true },
  { kind: "deadline", re: /\b(ends?|closes?|expires?)\s+(tonight|today|tomorrow|this week|[A-Z][a-z]+\s+\d{1,2})\b/i, concrete: true },
  { kind: "today_only", re: /\btoday only\b/i, concrete: true },
  { kind: "limited_spots", re: /\b(only\s+\d+\s+(spots?|seats?|places?)( left)?|limited (spots?|seats?|availability))\b/i, concrete: false },
  { kind: "price_increase", re: /\b(price increases?|goes up|after (this|tonight) .{0,20}price)\b/i, concrete: false },
  { kind: "scarcity", re: /\b(last chance|almost gone|selling out|while (supplies|spots) last|hurry)\b/i, concrete: false },
  { kind: "temporary_offer", re: /\b(limited[- ]time|for a short time|this offer expires)\b/i, concrete: false },
  { kind: "expiration", re: /\b(expir(es|ing)|deadline|final hours?|doors? clos(e|ing))\b/i, concrete: false },
];

export function detectUrgency(snapshot: DomSnapshot): UrgencyRecord[] {
  const records: UrgencyRecord[] = [];
  const seen = new Set<string>();

  for (const timer of snapshot.timers) {
    const key = `timer:${timer.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      text: timer.text,
      kind: "countdown_timer",
      concrete_deadline_visible: /\d/.test(timer.text),
      timer_value: timer.text,
      position: timer.y < snapshot.viewport.height ? "above_fold" : "below_fold",
    });
  }

  const blocks = [
    ...snapshot.headings.map((h) => ({ text: h.text, position: h.position })),
    ...snapshot.paragraphs.map((p) => ({ text: p.text, position: p.position })),
    ...snapshot.buttons.map((b) => ({ text: b.text, position: b.position })),
  ];

  for (const block of blocks) {
    for (const { kind, re, concrete } of PATTERNS) {
      const match = block.text.match(re);
      if (!match) continue;
      const key = `${kind}:${match[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        text: block.text.slice(0, 240),
        kind,
        concrete_deadline_visible: concrete,
        timer_value: kind === "countdown_timer" ? match[0] : null,
        position: block.position,
      });
    }
  }

  return records;
}
