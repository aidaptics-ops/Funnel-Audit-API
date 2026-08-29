import type { CaptureResult } from "../../pipeline/capture.js";
import type { DomSnapshot, MetaRecord } from "../../types/index.js";
import type { PageSection } from "../landing_types.js";

/** Large pages are trimmed for transport; the counts still describe the whole page. */
const VISIBLE_TEXT_LIMIT = 20000;

export function buildPage(capture: CaptureResult): PageSection {
  const snapshot = capture.snapshot;
  const fullText = snapshot.visible_text || "";
  const truncated = fullText.length > VISIBLE_TEXT_LIMIT;

  return {
    url: capture.requested_url,
    final_url: capture.final_url,
    http_status: capture.http_status,
    status_text: capture.status_text,
    content_type: capture.content_type,
    redirect_chain: capture.redirect_chain,
    title: emptyToNull(snapshot.title),
    meta_description: snapshot.meta.description ?? null,
    canonical: snapshot.meta.canonical ?? null,
    language: snapshot.lang ?? null,
    viewport_meta: viewportMeta(snapshot),
    charset: charset(snapshot.meta),
    dimensions: {
      viewport_width: snapshot.viewport.width,
      viewport_height: snapshot.viewport.height,
      scroll_width: snapshot.viewport.scroll_width,
      scroll_height: snapshot.viewport.scroll_height,
      fold_height: snapshot.viewport.height,
    },
    timing: {
      navigation_ms: capture.timing.navigation_ms,
      render_wait_ms: capture.timing.render_wait_ms,
      total_ms: capture.timing.total_ms,
    },
    visible_text: {
      characters: fullText.length,
      words: countWords(fullText),
      truncated,
      text: truncated ? fullText.slice(0, VISIBLE_TEXT_LIMIT) : fullText,
    },
    sections: snapshot.sections ?? [],
    dom: {
      headings: snapshot.headings.length,
      paragraphs: snapshot.paragraphs.length,
      links: snapshot.links.length,
      buttons: snapshot.buttons.length,
      forms: snapshot.forms.length,
      images: snapshot.images.length,
      iframes: snapshot.iframes.length,
      scripts: snapshot.scripts?.length ?? 0,
      videos: snapshot.videos.length,
    },
  };
}

function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * The snapshot records only whether the tag exists, not its content, so the
 * value is a presence marker rather than an invented content string.
 */
function viewportMeta(snapshot: DomSnapshot): string | null {
  const captured = (snapshot.meta as MetaRecord & { viewport?: string | null }).viewport;
  if (typeof captured === "string" && captured.trim()) return captured.trim();
  return snapshot.has_viewport_meta ? "present" : null;
}

/** Only reported when the snapshot actually carries it; never derived. */
function charset(meta: MetaRecord): string | null {
  const value = (meta as MetaRecord & { charset?: string | null }).charset;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}
