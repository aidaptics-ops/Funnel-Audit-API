import type { DomSnapshot, FaqItem, FaqSection } from "../types/index.js";

export function detectFaqs(snapshot: DomSnapshot): FaqSection[] {
  const sections: FaqSection[] = [];
  const schemaItems = fromJsonLd(snapshot.json_ld);
  if (schemaItems.length) {
    sections.push({
      heading: "FAQ (JSON-LD)",
      items: schemaItems,
      position: "unknown",
    });
  }

  const faqHeadings = snapshot.headings.filter((h) =>
    /\b(faq|frequently asked|common questions|questions\s*&\s*answers|q\s*&\s*a)\b/i.test(
      h.text,
    ),
  );

  for (const heading of faqHeadings) {
    const items: FaqItem[] = [];
    const followingHeadings = snapshot.headings.filter(
      (h) => h.y > heading.y && h.y < heading.y + 2500 && h.level > heading.level,
    );
    for (const q of followingHeadings) {
      if (/\b(faq|frequently)\b/i.test(q.text) && q !== heading) break;
      const answer = snapshot.paragraphs.find((p) => p.y > q.y && p.y < q.y + 400);
      if (/\?/.test(q.text) || q.text.length < 140) {
        items.push({
          question: q.text,
          answer: answer?.text || null,
          source: "heading",
        });
      }
    }

    const qParagraphs = snapshot.paragraphs.filter(
      (p) => p.y > heading.y && p.y < heading.y + 2500 && p.text.trim().endsWith("?"),
    );
    for (const q of qParagraphs) {
      if (items.some((i) => i.question === q.text)) continue;
      const answer = snapshot.paragraphs.find((p) => p.y > q.y && p.y < q.y + 300);
      items.push({
        question: q.text,
        answer: answer?.text || null,
        source: "text",
      });
    }

    if (items.length) {
      sections.push({
        heading: heading.text,
        items,
        position: heading.position,
      });
    }
  }

  const questionHeadings = snapshot.headings.filter(
    (h) => h.text.trim().endsWith("?") && h.level >= 3,
  );
  if (questionHeadings.length >= 3 && !faqHeadings.length) {
    sections.push({
      heading: "Detected question headings",
      items: questionHeadings.map((q) => ({
        question: q.text,
        answer:
          snapshot.paragraphs.find((p) => p.y > q.y && p.y < q.y + 300)?.text || null,
        source: "accordion" as const,
      })),
      position: questionHeadings[0].position,
    });
  }

  return sections;
}

function fromJsonLd(nodes: unknown[]): FaqItem[] {
  const items: FaqItem[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (type === "FAQPage" || (Array.isArray(type) && type.includes("FAQPage"))) {
      visit(obj.mainEntity);
    }
    if (type === "Question" || (Array.isArray(type) && type.includes("Question"))) {
      const accepted = obj.acceptedAnswer as Record<string, unknown> | undefined;
      items.push({
        question: String(obj.name || obj.text || ""),
        answer: accepted ? String(accepted.text || accepted.name || "") : null,
        source: "schema",
      });
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(nodes);
  return items.filter((i) => i.question);
}
