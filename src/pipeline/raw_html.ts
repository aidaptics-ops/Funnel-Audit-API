import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { logger } from "../logging/logger.js";

/**
 * The rendered markup itself.
 *
 * Everything else in this service reads the DOM through a collector, and a
 * collector only returns what it was taught to ask for. The raw HTML is the
 * evidence nobody pre-judged: the attribute this code has never heard of, the
 * vendor's own init snippet, the wrapper div whose class names give away which
 * page builder produced the funnel. Playwright collects what exists; deciding
 * what it means happens later, and that decision is only as good as what it can
 * still see here.
 *
 * Three things are elided and nothing else. Script and style bodies go because
 * a single bundle is routinely megabytes of minified noise that pushes the
 * actual page out of any context window - the tags and every attribute stay, so
 * which scripts the page loads is still fully readable. data: URIs go for the
 * same reason: an inlined image is a wall of base64 that says nothing. And the
 * value of a hidden, password, email or tel input goes because it is a
 * liability rather than evidence: the DOM collector deliberately reports only
 * that a hidden input has a value, and shipping the markup verbatim would hand
 * back the CSRF token, the session id and the prefilled email address it
 * refused to read. That an input exists, and what it is named, both stay.
 */

/** Per section. A page whose head alone exceeds this is pathological. */
const SECTION_CAP = 131_072;

/** A data: URI shorter than this is a marker or a tiny icon, and is left alone. */
const DATA_URI_KEEP = 64;

/**
 * The most document this process will pull out of the browser.
 *
 * Every other collector here is capped inside the page and hands back bounded
 * data. The markup is the one path that would ingest whatever a caller-supplied
 * URL chose to render - a page that appends nodes in a loop, an unpaginated
 * archive dump - as one JS string in the shared server process, with a second
 * full-size copy alongside it while the digest is taken. Several captures run
 * at once, so that is not one failed analysis but every in-flight one. The size
 * is measured in the browser first, where the string already exists, and past
 * this the markup is declined rather than read across.
 */
const DOCUMENT_CEILING_CHARS = 8_000_000;

/** page.content() fails while a navigation is in flight; this is the settle wait. */
const RETRY_DELAY_MS = 500;

export interface RawHtml {
  captured: boolean;
  /** Over the full document, before any truncation, so it identifies the page. */
  sha256: string | null;
  bytes: number;
  /** True when head or body_skeleton hit SECTION_CAP. */
  truncated: boolean;
  head: string;
  body_skeleton: string | null;
  note: string | null;
}

const EMPTY: RawHtml = {
  captured: false,
  sha256: null,
  bytes: 0,
  truncated: false,
  head: "",
  body_skeleton: null,
  note: null,
};

/**
 * Reads the serialised DOM as the browser currently holds it.
 *
 * Never throws. The markup is an enhancement over the collectors that already
 * ran, and losing it must not cost the caller an analysis that otherwise
 * succeeded - the same rule the screenshot step follows.
 */
export async function captureRenderedHtml(page: Page, budgetMs: number): Promise<RawHtml> {
  const startedAt = Date.now();

  // Measured before it is fetched. A refusal here costs the markup; reading the
  // string first and refusing afterwards would already have cost the memory.
  const size = await measureDocument(page, budgetMs);
  if (size !== null && size > DOCUMENT_CEILING_CHARS) {
    logger.warn(`Rendered HTML skipped: the document is ${size} characters`);
    return {
      ...EMPTY,
      note:
        `The document serialises to ${size} characters, past the ${DOCUMENT_CEILING_CHARS}-character ` +
        "capture ceiling; the markup was not read into the analysis process.",
    };
  }

  let html: string;
  try {
    // What is left of the budget after the measurement, so the guard above can
    // never push this step past the deadline it was given.
    html = await withBudget(page.content(), Math.max(1000, budgetMs - (Date.now() - startedAt)));
  } catch (first) {
    // "page is navigating and changing the content" is the observed failure: a
    // scripted redirect fired between the last stability wait and this call. One
    // retry after the hop settles is enough; a second failure is a real one.
    await page.waitForTimeout(RETRY_DELAY_MS).catch(() => undefined);
    try {
      html = await withBudget(page.content(), Math.max(1000, budgetMs - (Date.now() - startedAt)));
    } catch (second) {
      const message = describe(second);
      logger.warn(`Rendered HTML skipped: ${message} (first attempt: ${describe(first)})`);
      return { ...EMPTY, note: `Rendered HTML was not captured: ${message}` };
    }
  }

  // Everything from here works over a string the size of the page, and the
  // contract is that a capture never costs the caller their analysis. A digest
  // that runs out of buffer, or any other failure over a hostile document, ends
  // as a missing enhancement rather than a thrown request.
  try {
    // Hashed before anything is cut, so the digest identifies the whole document
    // and two captures of the same page compare equal whatever the caps did.
    const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
    const bytes = Buffer.byteLength(html, "utf8");

    const bodyAt = findBodyStart(html);
    const rawHead = redactInputValues(bodyAt === -1 ? html : html.slice(0, bodyAt));
    const head = rawHead.slice(0, SECTION_CAP);

    let bodySkeleton: string | null = null;
    let bodyTruncated = false;
    if (bodyAt !== -1) {
      const skeleton = elide(html.slice(bodyAt));
      bodySkeleton = skeleton.slice(0, SECTION_CAP);
      bodyTruncated = skeleton.length > bodySkeleton.length;
    }

    const headTruncated = rawHead.length > head.length;
    return {
      captured: true,
      sha256,
      bytes,
      truncated: headTruncated || bodyTruncated,
      head,
      body_skeleton: bodySkeleton,
      note:
        bodyAt === -1
          ? "The document has no <body> tag; the whole of it is reported as head."
          : headTruncated || bodyTruncated
            ? `The document is ${bytes} bytes; each section was capped at ${SECTION_CAP} characters.`
            : null,
    };
  } catch (error) {
    const message = describe(error);
    logger.warn(`Rendered HTML skipped while it was being prepared: ${message}`);
    return { ...EMPTY, note: `Rendered HTML was not captured: ${message}` };
  }
}

/**
 * How long the serialised document is, counted in the browser.
 *
 * Null when it cannot be measured - a navigation in flight, a page that will
 * not evaluate - in which case the caller proceeds as it always did. The
 * measurement guards against the pathological page; it is never a reason to
 * lose the markup of an ordinary one.
 */
async function measureDocument(page: Page, budgetMs: number): Promise<number | null> {
  try {
    const measured = await withBudget(
      page.evaluate(() =>
        String(document.documentElement ? document.documentElement.outerHTML.length : 0),
      ),
      Math.max(1000, Math.min(budgetMs, 5000)),
    );
    const value = Number(measured);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The first `<body` that is an element rather than text.
 *
 * A plain search takes the bait a head script sets: the serialiser writes
 * script and style bodies raw, so a script holding the string "<body class=x>"
 * puts a literal `<body` in the markup before the element ever appears.
 * Splitting there cuts the head mid-script, reports the rest of the head as the
 * body, and leaves the elision pass with no opening tag to match - so the
 * bundle it exists to drop ships in full, and `truncated` still reads false.
 * Script, style and comment regions are stepped over instead, since an element
 * cannot begin inside one.
 */
function findBodyStart(html: string): number {
  const opening = /<body(?=[\s/>])|<script\b|<style\b|<!--/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html)) !== null) {
    const token = match[0].toLowerCase();
    if (token.startsWith("<body")) return match.index;
    // Raw-text and comment content each end at exactly one sequence, and that
    // sequence cannot appear inside them: `</script` closes a script wherever
    // it is written, which is why a script can never contain one.
    const closing =
      token === "<!--" ? /-->/g : token === "<script" ? /<\/script\s*>/gi : /<\/style\s*>/gi;
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(html);
    // Unterminated: all that is left is that region's text, so no element follows.
    if (!end) return -1;
    opening.lastIndex = end.index + end[0].length;
  }
  return -1;
}

/** Input types whose value is a liability rather than evidence. */
const SENSITIVE_INPUT_TYPE = /^(hidden|password|email|tel)$/i;

/**
 * Replaces the value of a sensitive input with a note of its length.
 *
 * The rest of this service is careful never to read one: the snapshot reports
 * `value_present` and stops there. Shipping the markup verbatim would hand the
 * value back through the side door, so the same rule applies here. Only these
 * types are touched - a submit button's value is its label and a radio's value
 * is one of the choices the page offers, and both of those are evidence.
 */
function redactInputValues(markup: string): string {
  return markup.replace(/<input\b[^>]*>/gi, (tag: string) => {
    const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const declared = (type?.[1] ?? type?.[2] ?? type?.[3] ?? "text").trim();
    if (!SENSITIVE_INPUT_TYPE.test(declared)) return tag;
    return tag.replace(
      /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
      (_attr: string, doubled?: string, singled?: string, bare?: string) =>
        ` value="[elided ${(doubled ?? singled ?? bare ?? "").length} chars]"`,
    );
  });
}

/**
 * Removes the bulk without removing the structure: every tag and every
 * attribute survives, only the text inside a script or style, the payload of a
 * long data: URI and the value of a sensitive input are replaced by a note
 * saying how much was dropped.
 */
function elide(body: string): string {
  return redactInputValues(body)
    .replace(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (_match, tag: string, attrs: string, inner: string) =>
      inner.length === 0
        ? `<${tag}${attrs}></${tag}>`
        : `<${tag}${attrs}>/* elided ${inner.length} chars */</${tag}>`,
    )
    .replace(/data:[^"'\s>]+/g, (match: string) =>
      match.length > DATA_URI_KEEP ? `data:[elided ${match.length} chars]` : match,
    );
}

/**
 * page.content() carries no timeout of its own, so a page whose main frame
 * never settles would hold the capture past its deadline.
 */
async function withBudget(work: Promise<string>, timeoutMs: number): Promise<string> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`page.content() exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
