import type { Frame, Page } from "playwright";
import { isCalendarEmbedSrc, schedulerProvider } from "../extraction/embed_hosts.js";
import type { PageRecord } from "../types/index.js";

export interface SchedulingPresence {
  detected: boolean;
  provider: string | null;
  /** Where the scheduler lives: the page itself or an embedded frame. */
  surface: "page" | "iframe" | "text" | "none";
  url: string | null;
  /**
   * Whether the scheduler is on screen. Multi-step embeds preload their
   * scheduler iframe while it is still hidden, so "attached" is not "reached".
   */
  visible: boolean;
  evidence: string[];
}

// Picker-UI language only. "Book a call" is CTA copy, not a scheduler on screen.
const SCHEDULING_TEXT =
  /\b(select a (day|date)|select a date ?& ?time|pick a time|choose a time|available times?|no times available|time ?zone|\d{1,2} min(ute)?s? meeting)\b/i;

const CALENDLY_BOOKED_URL = /calendly\.com\/.+\/invitees\/|event_scheduled|invitees_created/i;

const BOOKED_TEXT =
  /\b(you are scheduled|you'?re scheduled|is scheduled|appointment (is )?(scheduled|confirmed|booked)|booking (is )?confirmed|event scheduled|your (call|meeting|appointment) is (booked|confirmed|scheduled)|see you (on|at)|a calendar invitation has been sent|confirmed! you are booked)\b/i;

const CALENDLY_BLOCKED_TEXT =
  /this booking cannot be completed|for security reasons, we are not able to finalize this booking/i;

/** Frames that look like a scheduling surface, outermost first. */
export function schedulerFrames(page: Page): Frame[] {
  return page.frames().filter((frame) => isCalendarEmbedSrc(frame.url()));
}

export async function detectScheduling(page: Page, record?: PageRecord): Promise<SchedulingPresence> {
  const evidence: string[] = [];

  const pageProvider = schedulerProvider(page.url());
  if (pageProvider) {
    evidence.push(`page URL is a ${pageProvider} scheduling page`);
    return { detected: true, provider: pageProvider, surface: "page", url: page.url(), visible: true, evidence };
  }

  let hiddenFrame: SchedulingPresence | null = null;
  for (const frame of page.frames()) {
    const provider = schedulerProvider(frame.url());
    if (!provider) continue;
    const visible = await frameIsVisible(frame);
    const presence: SchedulingPresence = {
      detected: true,
      provider,
      surface: "iframe",
      url: frame.url(),
      visible,
      evidence: [
        `${visible ? "visible" : "attached but hidden"} frame ${frame.url()} is a ${provider} scheduler`,
      ],
    };
    if (visible) return presence;
    hiddenFrame = hiddenFrame || presence;
  }

  const iframes = record?.iframes || [];
  for (const iframe of iframes) {
    const provider = schedulerProvider(iframe.src);
    if (!provider) continue;
    const presence: SchedulingPresence = {
      detected: true,
      provider,
      surface: "iframe",
      url: iframe.src,
      visible: iframe.visible,
      evidence: [`iframe element ${iframe.src} is a ${provider} scheduler`],
    };
    if (iframe.visible) return presence;
    hiddenFrame = hiddenFrame || presence;
  }

  const text = record?.visible_text || (await safeText(page));
  if (SCHEDULING_TEXT.test(text)) {
    const match = text.match(SCHEDULING_TEXT);
    evidence.push(`scheduling language on the page: "${match?.[0] ?? ""}"`);
    return { detected: true, provider: null, surface: "text", url: page.url(), visible: true, evidence };
  }

  if (record && (record.page_type === "calendar" || record.page_type === "booking")) {
    evidence.push(`page classified as ${record.page_type}`);
    return { detected: true, provider: null, surface: "text", url: page.url(), visible: true, evidence };
  }

  if (hiddenFrame) return hiddenFrame;

  return { detected: false, provider: null, surface: "none", url: null, visible: false, evidence };
}

/** A scheduler inside a `display:none` step is loaded but not yet reached. */
async function frameIsVisible(frame: Frame): Promise<boolean> {
  try {
    const element = await frame.frameElement();
    const visible = await element.isVisible();
    await element.dispose().catch(() => undefined);
    return visible;
  } catch {
    // Detached or not inspectable: assume it counts, the caller re-checks.
    return true;
  }
}

export interface BookingEvidence {
  booked: boolean;
  signal: "invitee_url" | "confirmation_text" | "none";
  detail: string;
}

/** Reads booking state from the page and every attached frame. */
export async function readBookingEvidence(page: Page): Promise<BookingEvidence> {
  if (CALENDLY_BOOKED_URL.test(page.url())) {
    return { booked: true, signal: "invitee_url", detail: `page URL ${page.url()}` };
  }
  for (const frame of page.frames()) {
    if (CALENDLY_BOOKED_URL.test(frame.url())) {
      return { booked: true, signal: "invitee_url", detail: `frame URL ${frame.url()}` };
    }
  }

  const surfaces: Array<{ label: string; text: string }> = [];
  surfaces.push({ label: "page", text: await safeText(page) });
  for (const frame of schedulerFrames(page)) {
    surfaces.push({ label: `frame ${frame.url()}`, text: await safeFrameText(frame) });
  }

  for (const surface of surfaces) {
    if (!surface.text) continue;
    if (CALENDLY_BLOCKED_TEXT.test(surface.text)) continue;
    const match = surface.text.match(BOOKED_TEXT);
    if (match) {
      return {
        booked: true,
        signal: "confirmation_text",
        detail: `${surface.label}: "${match[0]}"`,
      };
    }
  }

  return { booked: false, signal: "none", detail: "" };
}

/**
 * Text inside scheduling/form embeds. `document.body.innerText` stops at a
 * cross-origin iframe, so an embedded confirmation is invisible without this.
 */
export async function readEmbeddedText(page: Page): Promise<Array<{ url: string; text: string }>> {
  const out: Array<{ url: string; text: string }> = [];
  if (page.isClosed()) return out;
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url || url === "about:blank") continue;
    if (!isCalendarEmbedSrc(url) && !/typeform\.com|jotform|tally\.so|fillout|leadconnectorhq|msgsndr/i.test(url)) {
      continue;
    }
    const text = await safeFrameText(frame);
    if (text.trim()) out.push({ url, text: text.replace(/\s+/g, " ").trim().slice(0, 8000) });
  }
  return out;
}

/** Calendly's own refusal message, so the run can report it instead of hanging. */
export async function readSchedulerBlockMessage(page: Page): Promise<string | null> {
  const texts = [await safeText(page)];
  for (const frame of schedulerFrames(page)) texts.push(await safeFrameText(frame));
  for (const text of texts) {
    if (text && CALENDLY_BLOCKED_TEXT.test(text)) {
      const index = text.search(CALENDLY_BLOCKED_TEXT);
      return text.slice(index, index + 260).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

async function safeText(page: Page): Promise<string> {
  if (page.isClosed()) return "";
  return page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
}

async function safeFrameText(frame: Frame): Promise<string> {
  return frame
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
}

export { SCHEDULING_TEXT, BOOKED_TEXT, CALENDLY_BOOKED_URL, CALENDLY_BLOCKED_TEXT };
