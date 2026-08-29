import type { DomSnapshot, SocialProofRecord, TestimonialRecord } from "../types/index.js";

const TESTIMONIAL_HEADINGS =
  /\b(testimonial|reviews?|what (our )?(clients|students|customers|people) (say|are saying)|success stor|case stud|love us)\b/i;

const RESULT_PATTERN =
  /\$[\d,]+|\d+\s*%|\d+x|\b(double[d]?|tripl[ed]|booked|closed|lost \d+|gained \d+|lbs?|pounds|kg)\b/i;

const NAME_PATTERN = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z]\.?)?$/;

const PROBLEM_STATEMENT =
  /\b(i('ve| have) already tried|nothing sticks|too drained|so unpredictable|juggling work|motivation doesn'?t|i want to train but|by the time there'?s a window|even when i do get free time)\b/i;

export function detectTestimonials(snapshot: DomSnapshot): TestimonialRecord[] {
  const records: TestimonialRecord[] = [];
  const seen = new Set<string>();

  const quoteBlocks = snapshot.paragraphs.filter((p) => {
    const t = p.text.trim();
    return (
      (t.startsWith('"') || t.startsWith("“") || t.startsWith("'")) &&
      t.length > 40 &&
      t.length < 800
    );
  });

  for (const block of quoteBlocks) {
    const key = block.text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isProblemStatement(block.text)) continue;

    const nameGuess = guessName(snapshot, block.y);
    const hasResult = RESULT_PATTERN.test(block.text);
    const format =
      nameGuess || hasResult ? "quoted_text" : "testimonial_like_text";

    records.push({
      text: block.text,
      name: nameGuess,
      claimed_result: hasResult ? extractResult(block.text) : null,
      format,
      visible: block.visible,
      position: block.position,
      section: headingNear(snapshot, block.y),
      y: block.y,
    });
  }

  for (const heading of snapshot.headings) {
    if (!TESTIMONIAL_HEADINGS.test(heading.text)) continue;
    const nearby = snapshot.paragraphs.filter(
      (p) => p.y >= heading.y && p.y < heading.y + 900 && p.text.length > 40,
    );
    for (const p of nearby.slice(0, 6)) {
      const key = p.text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isProblemStatement(p.text)) continue;
      records.push({
        text: p.text,
        name: guessName(snapshot, p.y),
        claimed_result: RESULT_PATTERN.test(p.text) ? extractResult(p.text) : null,
        format: "section_under_heading",
        visible: p.visible,
        position: p.position,
        section: heading.text,
        y: p.y,
      });
    }
  }

  return records;
}

export function isProblemStatement(text: string): boolean {
  return PROBLEM_STATEMENT.test(text) && !RESULT_PATTERN.test(text);
}

export function detectSocialProof(
  snapshot: DomSnapshot,
  testimonials: TestimonialRecord[],
): SocialProofRecord[] {
  const items: SocialProofRecord[] = [];

  for (const t of testimonials) {
    items.push({
      kind: t.format === "testimonial_like_text" ? "testimonial_like_text" : "testimonial",
      text: t.text.slice(0, 280),
      position: t.position,
      section: t.section,
    });
  }

  const numberHits = snapshot.visible_text.match(
    /\b(\d{1,3}(?:,\d{3})+|\d+\+?)\s+(students|clients|customers|members|founders|businesses|reviews|stars)\b/gi,
  );
  for (const hit of numberHits?.slice(0, 10) || []) {
    items.push({
      kind: "quantified_number",
      text: hit,
      position: "unknown",
      section: null,
    });
  }

  const logoAlts = snapshot.images.filter(
    (img) => /logo|as seen|featured|press/i.test(`${img.alt || ""} ${img.src || ""}`) && img.visible,
  );
  for (const logo of logoAlts.slice(0, 12)) {
    items.push({
      kind: "logo",
      text: logo.alt || logo.src || "logo image",
      position: logo.position,
      section: "logos",
    });
  }

  if (/\bcase stud/i.test(snapshot.visible_text)) {
    items.push({
      kind: "case_study_language",
      text: "Case study language detected on page",
      position: "unknown",
      section: null,
    });
  }

  return items;
}

function guessName(snapshot: DomSnapshot, y: number): string | null {
  const nearby = snapshot.paragraphs
    .filter((p) => p.y >= y && p.y <= y + 80 && p.text.length < 60)
    .map((p) => p.text.replace(/^[-–—]\s*/, "").trim());
  for (const t of nearby) {
    if (NAME_PATTERN.test(t)) return t;
  }
  return null;
}

function extractResult(text: string): string | null {
  const m = text.match(/(\$[\d,]+(?:k|m)?|\d+\s*%|\d+x[^.!]{0,40}|lost \d+|gained \d+)/i);
  return m ? m[0].trim() : null;
}

function headingNear(snapshot: DomSnapshot, y: number): string | null {
  return snapshot.headings.filter((h) => h.y <= y).sort((a, b) => b.y - a.y)[0]?.text || null;
}
