import type { Page } from "playwright";
import { logger } from "../logging/logger.js";

/**
 * What the page actually looks like, in strips.
 *
 * Every other part of this service reasons about the DOM, and the DOM lies by
 * omission. A GoHighLevel funnel renders a large, obvious opt-in button with no
 * `href` — the click is handled in JavaScript and opens a modal — so a
 * structural reading concludes "the calls to action lead nowhere and there is
 * no form on the page". That is literally true about the markup and completely
 * wrong about the page, and an email built on it tells a prospect their working
 * funnel is broken.
 *
 * A picture has no such blind spot. This exists so the model that writes the
 * email can look at the page the way the prospect does, and disagree with the
 * DOM when the DOM is being pedantic.
 *
 * Strips rather than one tall image: a vision model scales an image so its long
 * edge fits ~1568px, so a single 1440x9000 capture arrives as a 250px-wide
 * sliver with unreadable text. Each strip here is shorter than that limit, so
 * it is passed through at full resolution and the copy stays legible.
 */

/** Under the ~1568px long edge a vision model scales to, so nothing shrinks. */
const STRIP_HEIGHT = 1400;

/**
 * Six strips is ~8400px of page — past the point where a cold reader has
 * stopped scrolling anyway. A longer page is covered from the top down, which
 * is the half that decides whether anyone converts.
 */
const MAX_STRIPS = 6;

/** JPEG at this quality is roughly a fifth the size of PNG and reads the same. */
const JPEG_QUALITY = 72;

/** Pages that report an absurd height are almost always an infinite scroller. */
const MAX_PAGE_HEIGHT = 40_000;

export interface PageStrip {
  /** 0-based, top to bottom. */
  index: number;
  /** Where this strip starts on the page, in CSS pixels. */
  offset_y: number;
  height: number;
  width: number;
  media_type: "image/jpeg";
  /** Base64, no data: prefix — the caller decides how to frame it. */
  data: string;
}

export interface PageScreenshot {
  captured: boolean;
  /** The full rendered height, even when only part of it was captured. */
  page_height: number;
  /** True when the page was taller than MAX_STRIPS could cover. */
  truncated: boolean;
  strips: PageStrip[];
  note: string | null;
}

const EMPTY: PageScreenshot = {
  captured: false,
  page_height: 0,
  truncated: false,
  strips: [],
  note: null,
};

/**
 * Photographs the rendered page in horizontal strips.
 *
 * Runs after extraction, so it sees the page in the same settled state
 * everything else was measured from. Never throws: a screenshot is an
 * enhancement, and losing it must not cost the caller an analysis that
 * otherwise succeeded.
 */
export async function capturePageStrips(page: Page, deadlineMs: number): Promise<PageScreenshot> {
  const startedAt = Date.now();

  try {
    const viewport = page.viewportSize();
    const width = viewport?.width ?? 1440;

    const pageHeight = await page.evaluate(`(() => {
      const d = document.documentElement;
      const b = document.body;
      return Math.max(
        d?.scrollHeight ?? 0, d?.offsetHeight ?? 0,
        b?.scrollHeight ?? 0, b?.offsetHeight ?? 0,
      );
    })()`) as number;

    const height = Math.min(Math.max(Number(pageHeight) || 0, 1), MAX_PAGE_HEIGHT);
    if (height <= 1) return { ...EMPTY, note: "The page reported no height." };

    // Back to the top: lazy-content settling leaves the viewport wherever it
    // finished, and a clip is relative to the document, not the scroll offset.
    await page.evaluate("window.scrollTo(0, 0)").catch(() => undefined);

    const wanted = Math.ceil(height / STRIP_HEIGHT);
    const count = Math.min(wanted, MAX_STRIPS);
    const strips: PageStrip[] = [];

    for (let index = 0; index < count; index += 1) {
      if (Date.now() - startedAt > deadlineMs) {
        logger.warn(`Screenshot deadline reached after ${strips.length} strip(s)`);
        break;
      }

      const offsetY = index * STRIP_HEIGHT;
      const stripHeight = Math.min(STRIP_HEIGHT, height - offsetY);
      if (stripHeight <= 0) break;

      // fullPage makes the clip document-relative, so no scrolling is needed
      // and a sticky header cannot be photographed once per strip.
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: JPEG_QUALITY,
        fullPage: true,
        clip: { x: 0, y: offsetY, width, height: stripHeight },
        animations: "disabled",
        caret: "hide",
      });

      strips.push({
        index,
        offset_y: offsetY,
        height: stripHeight,
        width,
        media_type: "image/jpeg",
        data: buffer.toString("base64"),
      });
    }

    if (strips.length === 0) return { ...EMPTY, page_height: height, note: "No strip could be captured." };

    const truncated = wanted > strips.length;
    return {
      captured: true,
      page_height: height,
      truncated,
      strips,
      note: truncated
        ? `The page is ${height}px tall; the top ${strips.length * STRIP_HEIGHT}px was captured.`
        : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Screenshot skipped: ${message}`);
    return { ...EMPTY, note: `Screenshot did not complete: ${message}` };
  }
}
