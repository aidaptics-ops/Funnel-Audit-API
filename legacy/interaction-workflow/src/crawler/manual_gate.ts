import { createInterface } from "node:readline";
import type { Page } from "playwright";
import { logger } from "../logging/logger.js";
import type { ManualGateKind, ManualGateResult, ManualGateSignal } from "../types/index.js";
import type { EmbedEventBus } from "./embed_events.js";
import { readEmbeddedFormStatus, TERMINAL_TEXT } from "./embed_completion.js";
import { isBrowserErrorUrl, isSameDocument } from "./page_stability.js";
import {
  detectScheduling,
  readBookingEvidence,
  readSchedulerBlockMessage,
  type SchedulingPresence,
} from "./scheduling_detector.js";

const POLL_MS = 600;
const HEARTBEAT_MS = 30000;


export interface ManualGateOptions {
  /** Hard ceiling for the wait. Detection normally ends the gate much sooner. */
  timeoutMs: number;
  /** Allow the operator to release the gate from the terminal. */
  operatorPrompt: boolean;
  events?: EmbedEventBus;
  /**
   * Called once the gate is armed and the baseline is captured. Used by tests
   * and by any future driver that stands in for the human.
   */
  onGateOpen?: (page: Page, kind: ManualGateKind) => unknown;
}

export interface ManualGateOutcome {
  result: ManualGateResult;
  /** The page to keep working with (a popup replaces the original). */
  page: Page;
}

interface Baseline {
  documentUrl: string;
  pages: Set<Page>;
  frameUrls: Set<string>;
  bodyText: string;
  schedulerVisible: boolean;
  eventIndex: number;
}

export class ManualGate {
  constructor(private readonly options: ManualGateOptions) {}

  /**
   * Hands the browser to a human, then returns as soon as the funnel shows an
   * observable sign that the form went through.
   */
  async waitForFormSubmission(page: Page): Promise<ManualGateOutcome> {
    printBanner([
      "MANUAL STEP — fill in and submit the form in the browser window.",
      "The crawler is not touching the page. It is watching for the submission.",
      "It resumes automatically on redirect, a new tab, a scheduler, or a thank-you screen.",
    ], this.options.operatorPrompt);

    return this.wait(page, "form_submission", (baseline, active) => this.formProbe(baseline, active));
  }

  /**
   * Some embedded forms keep going after the booking (a Typeform with a
   * Calendly block in the middle). Same signals, different instruction.
   */
  async waitForEmbeddedFormCompletion(page: Page): Promise<ManualGateOutcome> {
    printBanner([
      "MANUAL STEP — the embedded form is still open after the booking.",
      "Finish the remaining questions and submit it.",
      "The crawler resumes on the redirect or the thank-you screen.",
    ], this.options.operatorPrompt);

    return this.wait(page, "form_submission", (baseline, active) => this.formProbe(baseline, active));
  }

  private async formProbe(
    baseline: Baseline,
    active: Page,
  ): Promise<{ signal: ManualGateSignal; detail: string } | null> {
    const navigated = await detectNavigation(baseline, active);
    if (navigated) return navigated;

    const scheduling = await detectScheduling(active);
    if (isSchedulerSurface(scheduling) && !baseline.schedulerVisible) {
      return {
        signal: "scheduling_embed_appeared",
        detail: scheduling.evidence.join("; ") || "scheduling surface appeared",
      };
    }

    // Provider-aware: an embedded form is only done when the provider says so,
    // its thank-you screen renders, or its questions are gone. Progress chrome
    // ("Next step", "Almost done") never ends the wait.
    const embedded = await readEmbeddedFormStatus(active, {
      events: this.options.events,
      sinceEventIndex: baseline.eventIndex,
    });
    if (embedded.state === "completed") {
      return { signal: "embed_form_submitted", detail: embedded.evidence };
    }
    if (embedded.state === "in_progress") {
      // The page around an open embed says nothing about the embed's state.
      return null;
    }

    const body = await bodyText(active);
    if (newMatch(TERMINAL_TEXT, body, baseline.bodyText)) {
      return {
        signal: "confirmation_text",
        detail: `page shows "${firstMatch(TERMINAL_TEXT, body)}"`,
      };
    }

    return null;
  }

  /**
   * Waits for a human-completed booking. Calendly's own `event_scheduled`
   * message is the primary signal; URL and on-screen confirmation back it up.
   */
  async waitForBookingConfirmation(page: Page): Promise<ManualGateOutcome> {
    printBanner([
      "MANUAL STEP — pick a slot and complete the booking in the browser window.",
      "The crawler will not click anything in the scheduler.",
      "It resumes automatically once the booking is confirmed.",
    ], this.options.operatorPrompt);

    let blockedWarned = false;

    return this.wait(page, "booking_confirmation", async (baseline, active) => {
      const scheduled = this.options.events?.findSince(baseline.eventIndex, /^calendly\.event_scheduled$/i);
      if (scheduled) {
        return {
          signal: "calendly_event_scheduled",
          detail: `Calendly posted ${scheduled.name} from ${scheduled.origin || "the embed"}`,
        };
      }

      const evidence = await readBookingEvidence(active);
      if (evidence.booked) {
        return {
          signal: evidence.signal === "invitee_url" ? "calendly_invitee_url" : "calendly_confirmation_text",
          detail: evidence.detail,
        };
      }

      const navigated = await detectNavigation(baseline, active);
      if (navigated) {
        // A redirect off the scheduler is how most funnels confirm a booking.
        const stillScheduling = await detectScheduling(active);
        if (!stillScheduling.detected) return navigated;
      }

      if (!blockedWarned) {
        const blocked = await readSchedulerBlockMessage(active);
        if (blocked) {
          blockedWarned = true;
          logger.warn(`Scheduler refused the booking: ${blocked}`);
          logger.warn("Retry in the browser (a fresh reload usually works); the crawler keeps waiting.");
        }
      }

      return null;
    });
  }

  /** Fire-and-forget so the baseline is always captured before anything acts. */
  private announceGateOpen(page: Page, kind: ManualGateKind): void {
    const hook = this.options.onGateOpen;
    if (!hook) return;
    void (async () => {
      try {
        await hook(page, kind);
      } catch (error) {
        logger.warn(`Manual gate hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  private async wait(
    startPage: Page,
    kind: ManualGateKind,
    probe: (baseline: Baseline, page: Page) => Promise<{ signal: ManualGateSignal; detail: string } | null>,
  ): Promise<ManualGateOutcome> {
    const startedAt = new Date();
    const started = Date.now();
    const deadline = started + this.options.timeoutMs;
    const baseline = await captureBaseline(startPage, this.options.events);
    const seen: string[] = [];
    let active = startPage;
    let heartbeat = started;

    const operator = this.options.operatorPrompt ? openOperatorPrompt(kind) : null;
    this.announceGateOpen(startPage, kind);

    try {
      while (Date.now() < deadline) {
        if (operator?.answer) {
          const skipped = operator.answer === "skip";
          return finish(
            skipped ? "operator_skipped" : "operator_confirmed",
            "operator_input",
            skipped ? "operator skipped this step" : "operator confirmed the step is done",
          );
        }

        active = await activePage(active, baseline);
        if (active.isClosed()) {
          const replacement = livePages(baseline).at(-1);
          if (replacement) active = replacement;
        }

        let hit: { signal: ManualGateSignal; detail: string } | null = null;
        try {
          hit = await probe(baseline, active);
        } catch (error) {
          // Navigation mid-probe invalidates locators; the next tick re-reads.
          logger.debug(`Manual gate probe retry: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (hit) {
          seen.push(`${hit.signal}: ${hit.detail}`);
          logger.info(`Manual gate satisfied by ${hit.signal} — ${hit.detail}`);
          return finish("detected", hit.signal, hit.detail);
        }

        if (Date.now() - heartbeat >= HEARTBEAT_MS) {
          heartbeat = Date.now();
          const waited = Math.round((Date.now() - started) / 1000);
          const left = Math.round((deadline - Date.now()) / 1000);
          logger.info(`Still waiting for the manual ${label(kind)} (${waited}s elapsed, ${left}s left)`);
        }

        await sleep(POLL_MS);
      }

      logger.warn(`Manual ${label(kind)} timed out after ${Math.round(this.options.timeoutMs / 1000)}s`);
      return finish("timeout", "none", `no completion signal within ${this.options.timeoutMs}ms`);
    } finally {
      operator?.close();
    }

    function finish(
      status: ManualGateResult["status"],
      signal: ManualGateSignal,
      detail: string,
    ): ManualGateOutcome {
      const ended = new Date();
      return {
        page: active,
        result: {
          kind,
          status,
          signal,
          detail,
          started_at: startedAt.toISOString(),
          ended_at: ended.toISOString(),
          waited_ms: ended.getTime() - started,
          url_before: baseline.documentUrl,
          url_after: active.isClosed() ? baseline.documentUrl : active.url(),
          signals_seen: seen,
        },
      };
    }
  }
}

async function captureBaseline(page: Page, events?: EmbedEventBus): Promise<Baseline> {
  const scheduling = await detectScheduling(page);
  return {
    documentUrl: page.url(),
    pages: new Set(page.context().pages()),
    frameUrls: new Set(page.frames().map((frame) => frame.url())),
    bodyText: await bodyText(page),
    // Copy that mentions booking is not a scheduler; only a real surface counts.
    schedulerVisible: isSchedulerSurface(scheduling),
    eventIndex: events?.length ?? 0,
  };
}

async function detectNavigation(
  baseline: Baseline,
  page: Page,
): Promise<{ signal: ManualGateSignal; detail: string } | null> {
  const popup = livePages(baseline).find(
    (candidate) =>
      !baseline.pages.has(candidate) &&
      !isBrowserErrorUrl(candidate.url()) &&
      !isSameDocument(candidate.url(), baseline.documentUrl),
  );
  if (popup) {
    return { signal: "new_tab", detail: `new tab opened at ${popup.url()}` };
  }

  if (!page.isClosed() && !isSameDocument(baseline.documentUrl, page.url()) && !isBrowserErrorUrl(page.url())) {
    return { signal: "document_navigation", detail: `navigated to ${page.url()}` };
  }

  return null;
}

/** Switches to a popup once one exists, so probes read the live surface. */
async function activePage(current: Page, baseline: Baseline): Promise<Page> {
  const popup = livePages(baseline)
    .filter((candidate) => !baseline.pages.has(candidate) && !isBrowserErrorUrl(candidate.url()))
    .at(-1);
  if (!popup || popup === current) return current;
  await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
  return popup;
}

function livePages(baseline: Baseline): Page[] {
  const anyPage = [...baseline.pages][0];
  if (!anyPage) return [];
  return anyPage
    .context()
    .pages()
    .filter((candidate) => !candidate.isClosed());
}

async function bodyText(page: Page): Promise<string> {
  if (page.isClosed()) return "";
  return page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
}


function isSchedulerSurface(scheduling: SchedulingPresence): boolean {
  return scheduling.detected && scheduling.visible && scheduling.surface !== "text";
}

function newMatch(pattern: RegExp, current: string, baseline: string): boolean {
  if (!current) return false;
  if (!pattern.test(current)) return false;
  const found = firstMatch(pattern, current);
  if (!found) return false;
  // Only a phrase that was not already on screen counts as progress.
  return !baseline.toLowerCase().includes(found.toLowerCase());
}

function firstMatch(pattern: RegExp, text: string): string {
  return text.match(pattern)?.[0] ?? "";
}

function label(kind: ManualGateKind): string {
  return kind === "form_submission" ? "form submission" : "booking";
}

interface OperatorPrompt {
  answer: "done" | "skip" | null;
  close: () => void;
}

/**
 * Optional terminal escape hatch: the operator can release the gate when the
 * funnel confirms in a way the detectors do not recognise.
 */
function openOperatorPrompt(kind: ManualGateKind): OperatorPrompt | null {
  if (!process.stdin.isTTY) return null;
  const state: OperatorPrompt = { answer: null, close: () => undefined };
  const rl = createInterface({ input: process.stdin, terminal: false });
  const hint =
    kind === "form_submission"
      ? "Press Enter after submitting the form (or type: skip)"
      : "Press Enter after the booking is confirmed (or type: skip)";
  console.log(`  ${hint}`);
  rl.on("line", (line) => {
    state.answer = line.trim().toLowerCase() === "skip" ? "skip" : "done";
  });
  state.close = () => {
    rl.removeAllListeners("line");
    rl.close();
  };
  process.stdin.unref?.();
  return state;
}

function printBanner(lines: string[], operatorPrompt: boolean): void {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  console.log("");
  console.log("=".repeat(width));
  for (const line of lines) console.log(`  ${line}`);
  if (!operatorPrompt) console.log("  (terminal input is unavailable; detection only)");
  console.log("=".repeat(width));
  console.log("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { TERMINAL_TEXT, newMatch };
