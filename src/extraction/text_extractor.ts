import type { DomSnapshot, HeadingRecord, TextBlock } from "../types/index.js";

export function extractText(snapshot: DomSnapshot): {
  headings: HeadingRecord[];
  subheadings: HeadingRecord[];
  paragraphs: TextBlock[];
  visible_text: string;
} {
  const headings = snapshot.headings.filter((h) => h.level <= 2);
  const subheadings = snapshot.headings.filter((h) => h.level >= 3);
  return {
    headings,
    subheadings,
    paragraphs: snapshot.paragraphs,
    visible_text: snapshot.visible_text,
  };
}
