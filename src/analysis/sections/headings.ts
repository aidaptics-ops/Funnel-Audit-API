import type { CaptureResult } from "../../pipeline/capture.js";
import type { HeadingEntry } from "../landing_types.js";

const MAX_ENTRIES = 200;

/** Every heading the snapshot recorded, in document order. */
export function buildHeadings(capture: CaptureResult): HeadingEntry[] {
  const entries: HeadingEntry[] = [];

  for (const heading of capture.snapshot.headings) {
    if (entries.length >= MAX_ENTRIES) break;
    const text = (heading.text || "").trim();
    if (!text) continue;
    entries.push({
      level: heading.level,
      text,
      length: text.length,
      visible: heading.visible,
      above_fold: heading.position === "above_fold",
      y: heading.y,
    });
  }

  return entries;
}
