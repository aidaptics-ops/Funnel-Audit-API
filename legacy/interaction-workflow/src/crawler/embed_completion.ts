import type { Frame, Page } from "playwright";
import { embedProvider, isCalendarEmbedSrc, isFormEmbedSrc } from "../extraction/embed_hosts.js";
import type { EmbedEventBus } from "./embed_events.js";

export type EmbedFormState = "absent" | "in_progress" | "completed";

export interface EmbedFormStatus {
  present: boolean;
  provider: string | null;
  state: EmbedFormState;
  frame_url: string | null;
  /** Why the state was chosen, for the gate result and the report. */
  evidence: string;
}

/**
 * Terminal wording only. Anything that merely means "there is more to do"
 * belongs in PROGRESS_TEXT below, never here.
 */
export const TERMINAL_TEXT =
  /\b(thank you|thanks!|you'?re all set|you'?re in\b|(?:your\s+)?(?:application|request|submission|response|answers?|form|booking|registration)s?\s+(?:was\s+|were\s+|has\s+been\s+|have\s+been\s+|is\s+|are\s+)?(?:received|recorded|complete|completed|submitted|confirmed)|form submitted|successfully submitted|we(?:'|’)?ll be in touch|we (?:have )?received your)\b/i;

/**
 * Multi-step chrome. A Typeform shows "Next step" / "Almost done" while the
 * form is still open, so these can never end the wait.
 */
export const PROGRESS_TEXT =
  /\b(next step|next question|continue|proceed|almost done|keep going|nearly there|step\s*\d+\s*(of|\/)\s*\d+|\d+\s*(of|\/)\s*\d+\s*(questions?|steps?)|press enter|powered by)\b/i;

/** Provider events that mean the whole form was submitted. */
const COMPLETION_EVENTS = /^(typeform\.form-submit|typeform\.thank-you-screen|jotform\.submission-completed|tally\.form-submit|fillout\.form-submit)$/i;

const THANKYOU_MARKERS = [
  '[data-qa="thank-you-screen"]',
  '[data-qa="thankyou-screen"]',
  '[data-qa*="thank-you" i]',
  '[data-qa*="thankyou" i]',
  '[data-qa-blockref*="thankyou" i]',
  '[data-qa-blockref*="thank_you" i]',
  ".thankyou-screen",
  ".thank-you-screen",
];

const QUESTION_MARKERS = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[data-qa="choice"]',
  '[data-qa="picture-choice"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[data-qa-focused="true"]',
];

interface FrameDom {
  thankYouMarker: boolean;
  openQuestions: number;
  text: string;
}

/**
 * Reads how far an embedded form has actually got. Provider events first, then
 * DOM structure, then strict terminal wording — never generic progress text.
 */
export async function readEmbeddedFormStatus(
  page: Page,
  opts?: { events?: EmbedEventBus; sinceEventIndex?: number },
): Promise<EmbedFormStatus> {
  if (page.isClosed()) {
    return { present: false, provider: null, state: "absent", frame_url: null, evidence: "page closed" };
  }

  const frames = page
    .frames()
    .filter((frame) => isFormEmbedSrc(frame.url()) && !isCalendarEmbedSrc(frame.url()));

  if (!frames.length) {
    return { present: false, provider: null, state: "absent", frame_url: null, evidence: "no embedded form frame" };
  }

  const providerEvent = opts?.events?.findSince(opts.sinceEventIndex ?? 0, COMPLETION_EVENTS);
  if (providerEvent) {
    return {
      present: true,
      provider: embedProvider(providerEvent.frame_url || "") || providerOf(frames),
      state: "completed",
      frame_url: providerEvent.frame_url,
      evidence: `the embed posted ${providerEvent.name}`,
    };
  }

  let inProgressEvidence = "the embedded form is still open";
  for (const frame of frames) {
    const provider = embedProvider(frame.url()) || "iframe";
    const dom = await readFrameDom(frame);
    if (!dom) continue;

    if (dom.thankYouMarker) {
      return {
        present: true,
        provider,
        state: "completed",
        frame_url: frame.url(),
        evidence: `${provider} rendered its thank-you screen`,
      };
    }

    // Terminal wording only counts once the questions are gone.
    const terminal = dom.text.match(TERMINAL_TEXT)?.[0];
    if (terminal && dom.openQuestions === 0) {
      return {
        present: true,
        provider,
        state: "completed",
        frame_url: frame.url(),
        evidence: `${provider} shows "${terminal}" with no question left on screen`,
      };
    }

    if (terminal && dom.openQuestions > 0) {
      inProgressEvidence = `${provider} shows "${terminal}" but ${dom.openQuestions} question element(s) are still on screen`;
    } else if (dom.openQuestions > 0) {
      inProgressEvidence = `${provider} still shows ${dom.openQuestions} question element(s)`;
    }
  }

  return {
    present: true,
    provider: providerOf(frames),
    state: "in_progress",
    frame_url: frames[0]?.url() ?? null,
    evidence: inProgressEvidence,
  };
}

/**
 * Evaluated as a plain string so it never depends on transpiler helpers being
 * present in the embedded document.
 */
function frameDomScript(): string {
  return `(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const count = (selectors) => {
      let total = 0;
      for (const selector of selectors) {
        try {
          total += Array.prototype.filter.call(document.querySelectorAll(selector), visible).length;
        } catch (error) {
          /* selector unsupported here */
        }
      }
      return total;
    };
    return {
      thankYouMarker: count(${JSON.stringify(THANKYOU_MARKERS)}) > 0,
      openQuestions: count(${JSON.stringify(QUESTION_MARKERS)}),
      text: ((document.body && document.body.innerText) || "").slice(0, 6000),
    };
  })()`;
}

async function readFrameDom(frame: Frame): Promise<FrameDom | null> {
  return frame.evaluate<FrameDom>(frameDomScript()).catch(() => null);
}

function providerOf(frames: Frame[]): string | null {
  for (const frame of frames) {
    const provider = embedProvider(frame.url());
    if (provider) return provider;
  }
  return frames.length ? "iframe" : null;
}

/** Terminal wording that is not multi-step progress chrome. */
export function isTerminalText(text: string): boolean {
  if (!text) return false;
  const terminal = text.match(TERMINAL_TEXT);
  if (!terminal) return false;
  // "Next step: check your email" is progress, not completion.
  return !PROGRESS_TEXT.test(terminal[0]);
}
