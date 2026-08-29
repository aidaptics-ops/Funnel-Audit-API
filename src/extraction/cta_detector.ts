import type { CtaRecord, DomSnapshot } from "../types/index.js";

const CTA_HINTS = [
  /\bapply( now)?\b/i,
  /\bbook( your)?( a| your)?( free)?\b/i,
  /\bschedule\b/i,
  /\bregister\b/i,
  /\bget access\b/i,
  /\bwatch( the)? (training|video|now)\b/i,
  /\bjoin( the| this)? (webinar|workshop|masterclass)?\b/i,
  /\bbuy now\b/i,
  /\bstart( my| your)? trial\b/i,
  /\bget started\b/i,
  /\bsave (my )?spot\b/i,
  /\breserve\b/i,
  /\bclaim\b/i,
  /\benroll\b/i,
  /\badd to cart\b/i,
  /\bcheckout\b/i,
  /\byes[, ]?i (want|m in|agree)/i,
  /\bcontinue\b/i,
  /\bsubmit\b/i,
  /\bsign up\b/i,
  /\bdownload\b/i,
  /\bget (the|my|your|instant)\b/i,
];

const IGNORE = [
  /^privacy/i,
  /^terms/i,
  /^cookie/i,
  /^login$/i,
  /^log in$/i,
  /^sign in$/i,
  /^home$/i,
  /^blog$/i,
  /^contact$/i,
  /^about$/i,
  /^learn more$/i,
  /^read more$/i,
  /^facebook$/i,
  /^instagram$/i,
  /^twitter$/i,
  /^linkedin$/i,
  /^youtube$/i,
];

export function detectCtas(snapshot: DomSnapshot): CtaRecord[] {
  const seen = new Set<string>();
  const ctas: CtaRecord[] = [];

  for (const btn of snapshot.buttons) {
    const text = (btn.text || "").trim();
    if (!text || text.length > 120) continue;
    if (IGNORE.some((re) => re.test(text))) continue;

    const isCta =
      btn.tag === "button" ||
      btn.type === "submit" ||
      CTA_HINTS.some((re) => re.test(text)) ||
      (btn.visible && text.length <= 40 && looksActionable(text));

    if (!isCta) continue;
    const key = `${text.toLowerCase()}|${btn.href || ""}|${btn.y}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const section = nearestHeading(snapshot, btn.y);
    const { supporting, headline, outcome } = surroundingCopy(snapshot, btn.y, text);

    ctas.push({
      text,
      type: btn.tag === "a" ? "link" : btn.type === "submit" ? "input" : "button",
      href: btn.href,
      visible: btn.visible,
      position: btn.position,
      section,
      x: btn.x ?? null,
      y: btn.y,
      supporting_copy: supporting,
      headline_above: headline,
      stated_outcome: outcome,
    });
  }

  return ctas.sort((a, b) => a.y - b.y);
}

function looksActionable(text: string): boolean {
  return /^(get|start|join|book|apply|register|buy|watch|claim|unlock|access|yes|continue|submit|download|reserve|enroll|try)\b/i.test(
    text,
  );
}

function nearestHeading(snapshot: DomSnapshot, y: number): string | null {
  const above = snapshot.headings.filter((h) => h.y <= y).sort((a, b) => b.y - a.y);
  return above[0]?.text || (y < snapshot.viewport.height ? "hero" : null);
}

function surroundingCopy(
  snapshot: DomSnapshot,
  y: number,
  ctaText: string,
): { supporting: string | null; headline: string | null; outcome: string | null } {
  const headline =
    snapshot.headings.filter((h) => h.y <= y).sort((a, b) => b.y - a.y)[0]?.text || null;
  const nearby = snapshot.paragraphs
    .filter((p) => Math.abs(p.y - y) < 280)
    .sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))
    .map((p) => p.text)
    .filter((t) => t && t !== ctaText)
    .slice(0, 2);
  const supporting = nearby.join(" ").slice(0, 400) || null;
  const outcome = inferOutcome(`${headline || ""} ${supporting || ""} ${ctaText}`);
  return { supporting, headline, outcome };
}

function inferOutcome(text: string): string | null {
  const m = text.match(
    /(?:so you can|to |and )\s*([a-z][^.]{8,80})/i,
  );
  if (m) return m[1].trim();
  if (/strategy call|discovery call|consultation/i.test(text)) return "book a call";
  if (/webinar|masterclass|workshop/i.test(text)) return "register for the event";
  if (/training|replay|video/i.test(text)) return "watch training";
  return null;
}
