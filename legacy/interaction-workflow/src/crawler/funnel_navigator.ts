import type { Page } from "playwright";
import { identityIsUsable } from "../config/load_config.js";
import { logger } from "../logging/logger.js";
import { analyzePage } from "../analysis/page_analyzer.js";
import type { ScreenshotManager } from "../screenshots/screenshot_manager.js";
import type {
  CheckpointHandler,
  CrawlConfig,
  CrawlError,
  CrawlReport,
  FormRecord,
  FunnelCheckpoint,
  FunnelMetadata,
  FunnelStep,
  InteractionResult,
  ManualGateKind,
  ManualGateResult,
  ManualGateSignal,
  PageAnalysis,
  PageRecord,
  PageRole,
  RunMilestones,
} from "../types/index.js";
import { readEmbeddedFormStatus } from "./embed_completion.js";
import { InteractionEngine } from "./interaction_engine.js";
import { PageCrawler } from "./page_crawler.js";
import { detectBlocker, isBrowserErrorUrl, isSameDocument, normalizeUrl, waitForPageStable } from "./page_stability.js";
import { NetworkCapture } from "./network_capture.js";
import type { EmbedEventBus } from "./embed_events.js";
import { ManualGate } from "./manual_gate.js";
import type { RunStateMachine } from "./run_state.js";
import {
  detectScheduling,
  readBookingEvidence,
  readEmbeddedText,
  readSchedulerBlockMessage,
  type SchedulingPresence,
} from "./scheduling_detector.js";

const MAX_FORM_HOPS = 3;
const POST_BOOKING_REDIRECT_MS = 20000;

/** Signals that mean the form itself finished, not that it moved a step on. */
const ROLE_LABEL: Record<PageRole, string> = {
  landing: "Landing page",
  intermediate: "Funnel step",
  form: "Form",
  scheduling: "Scheduling",
  confirmation: "Confirmation",
};

/** Signals that mean the form itself finished, not that it moved a step on. */
const FORM_COMPLETION_SIGNALS = new Set<ManualGateSignal>([
  "document_navigation",
  "new_tab",
  "embed_form_submitted",
  "embed_completion_text",
  "confirmation_text",
  "operator_input",
]);

export interface ManualHooks {
  /**
   * Invoked once a manual gate is armed, with the page the human should act on.
   * Production runs leave this unset; tests and future drivers use it to stand
   * in for the operator.
   */
  onGateOpen?: (page: Page, kind: ManualGateKind) => unknown;
}

export interface NavigatorDeps {
  state: RunStateMachine;
  metadata: FunnelMetadata;
  events?: EmbedEventBus;
  hooks?: ManualHooks;
  /** Called as soon as a page is analysed, so artifacts land incrementally. */
  onPageAnalyzed?: (analysis: PageAnalysis) => void;
}

export interface NavigatorOutcome {
  report: CrawlReport;
  analyses: PageAnalysis[];
  landing: PageAnalysis | null;
  confirmation: PageAnalysis | null;
  confirmation_reason: string | null;
  manual_gates: ManualGateResult[];
  scheduling: { detected: boolean; provider: string | null; booked: boolean };
  milestones: RunMilestones;
  landing_record: PageRecord | null;
  blocked: boolean;
}

export class FunnelNavigator {
  private readonly pages: PageRecord[] = [];
  private readonly analyses: PageAnalysis[] = [];
  private readonly interactions: InteractionResult[] = [];
  private readonly errors: CrawlError[] = [];
  private readonly visited = new Set<string>();
  private readonly notes: string[] = [];
  private readonly manualGates: ManualGateResult[] = [];
  private readonly funnelPath: FunnelStep[] = [];
  private status: CrawlReport["status"] = "complete";
  private sameUrlAdvances = 0;
  private readonly clickedCtas = new Set<string>();
  private readonly submittedForms = new Set<string>();
  private readonly network = new NetworkCapture();
  private readonly crawler: PageCrawler;
  private readonly interactionEngine: InteractionEngine;
  private landing: PageAnalysis | null = null;
  private landingRecord: PageRecord | null = null;
  private confirmation: PageAnalysis | null = null;
  private confirmationReason: string | null = null;
  private blocked = false;
  private scheduling: { detected: boolean; provider: string | null; booked: boolean } = {
    detected: false,
    provider: null,
    booked: false,
  };
  private readonly milestones: RunMilestones = {
    landing_analyzed: false,
    form_located: false,
    form_submitted: false,
    scheduling_detected: false,
    booking_confirmed: false,
    confirmation_analyzed: false,
  };
  private sequence = 0;

  constructor(
    private readonly config: CrawlConfig,
    private readonly screenshots: ScreenshotManager,
    private readonly crawlId: string,
    private readonly deps: NavigatorDeps,
  ) {
    this.crawler = new PageCrawler(this.screenshots, this.network);
    this.interactionEngine = new InteractionEngine(this.config, this.screenshots);
  }

  async run(startPage: Page): Promise<NavigatorOutcome> {
    const startedAt = new Date().toISOString();
    this.network.attach(startPage);
    this.deps.state.transition("CRAWLING_LANDING_PAGE", { url: this.config.start_url });

    logger.step(1, this.config.max_pages, `Opening landing page ${this.config.start_url}`);
    try {
      await startPage.goto(this.config.start_url, { waitUntil: "domcontentloaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail("navigation", message, this.config.start_url);
      this.status = "failed";
      this.deps.state.transition("FAILED", { note: message });
      return this.outcome(startedAt);
    }

    try {
      if (this.config.manual_mode) await this.runManual(startPage);
      else await this.runAutomatic(startPage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail("navigation", message, startPage.isClosed() ? undefined : startPage.url());
      this.status = this.pages.length ? "partial" : "failed";
      this.deps.state.transition("FAILED", { note: message });
      return this.outcome(startedAt);
    }

    if (this.errors.length && this.status === "complete") this.status = "partial";
    logger.step(this.pages.length || 1, this.config.max_pages, "Crawl complete");
    if (this.deps.state.state !== "TASK_COMPLETED" && this.deps.state.state !== "FAILED") {
      this.deps.state.transition("TASK_COMPLETED", { note: "run finished" });
    }
    return this.outcome(startedAt);
  }

  /* ------------------------------------------------------------------ *
   * Manual mode: automate everything except the form and the booking
   * ------------------------------------------------------------------ */

  private async runManual(startPage: Page): Promise<void> {
    let page = startPage;

    const landing = await this.capture(page, "landing");
    if (!landing) {
      this.status = "failed";
      this.deps.state.transition("FAILED", { note: "landing page could not be captured" });
      return;
    }
    this.deps.state.transition("ANALYZING_LANDING_PAGE", { url: page.url() });
    this.landing = landing.analysis;
    this.landingRecord = landing.record;
    this.milestones.landing_analyzed = true;
    logger.info(
      `Landing page analysed: ${landing.analysis.forms.count} form(s), ${landing.analysis.ctas.count} CTA(s), ` +
        `${landing.analysis.videos.count} video(s), ${landing.analysis.detected_issues.length} issue(s)`,
    );

    if (this.blocked) {
      this.confirmationReason = "the landing page returned an anti-bot or access-denied screen";
      return;
    }

    this.deps.state.transition("LOCATING_FORM", { url: page.url() });
    const located = await this.locateForm(page, landing.record);
    page = located.page;
    let record = located.record;
    let scheduling = await detectScheduling(page, record);

    if (!located.form && !scheduling.detected) {
      this.notes.push("No form or scheduler was found in this funnel; nothing to hand over to a human.");
      this.confirmationReason = "the funnel exposes no form or scheduling step";
      logger.warn("No form found. Finishing after the landing-page analysis.");
      return;
    }

    if (located.form) {
      this.milestones.form_located = true;
      await this.revealForm(page, located.form);
      logger.info(
        `Form ready for manual entry: ${located.form.type} via ${located.form.method === "iframe" ? "embedded iframe" : "native form"}` +
          `${located.form.action ? ` (${located.form.action})` : ""}`,
      );
    }

    const gate = new ManualGate({
      timeoutMs: this.config.manual_form_timeout_ms,
      operatorPrompt: this.config.operator_prompt,
      events: this.deps.events,
      onGateOpen: this.deps.hooks?.onGateOpen,
    });

    // --- Manual form submission -------------------------------------
    if (located.form || !scheduling.detected) {
      this.deps.state.transition("WAITING_FOR_FORM_INPUT", { url: page.url() });
      const formGate = await gate.waitForFormSubmission(page);
      this.recordGate(formGate.result);
      page = formGate.page;
      this.network.attach(page);

      if (formGate.result.status === "timeout") {
        this.status = "partial";
        this.notes.push("Manual form submission timed out; analysing whatever the funnel showed last.");
      }
      if (formGate.result.status === "operator_skipped") {
        this.notes.push("Operator skipped the form step.");
      }
      // Reaching a scheduler mid-form is progress, not a submitted form.
      this.markFormSubmitted(formGate.result);
      if (formGate.result.signal === "scheduling_embed_appeared") {
        this.notes.push(
          "The scheduler opened inside the form; remaining questions are handled after the booking.",
        );
      }
      this.deps.state.transition("FORM_SUBMITTED", {
        url: page.url(),
        note: `${formGate.result.status} via ${formGate.result.signal}`,
      });

      await waitForPageStable(page).catch(() => []);
      const reachedScheduler = formGate.result.signal === "scheduling_embed_appeared";
      const post = await this.capture(page, reachedScheduler ? "scheduling" : "intermediate");
      if (post) record = post.record;
      scheduling = await detectScheduling(page, record);
    }

    // --- Manual booking ---------------------------------------------
    if (scheduling.detected) {
      this.scheduling = { detected: true, provider: scheduling.provider, booked: false };
      this.milestones.scheduling_detected = true;
      logger.info(`Scheduling step detected (${scheduling.provider || "unknown provider"}): ${scheduling.evidence[0] ?? ""}`);

      const already = await readBookingEvidence(page);
      if (already.booked) {
        this.scheduling.booked = true;
        this.milestones.booking_confirmed = true;
        this.deps.state.transition("BOOKING_CONFIRMED", { url: page.url(), note: already.detail });
      } else {
        this.deps.state.transition("WAITING_FOR_CALENDLY_BOOKING", { url: page.url() });
        const bookingGate = new ManualGate({
          timeoutMs: this.config.manual_booking_timeout_ms,
          operatorPrompt: this.config.operator_prompt,
          events: this.deps.events,
          onGateOpen: this.deps.hooks?.onGateOpen,
        });
        const result = await bookingGate.waitForBookingConfirmation(page);
        this.recordGate(result.result);
        page = result.page;
        this.network.attach(page);

        if (result.result.status === "timeout") {
          this.status = "partial";
          const blockedMessage = await readSchedulerBlockMessage(page);
          if (blockedMessage) {
            this.fail("booking", blockedMessage, page.url());
            this.notes.push(`Scheduler refused the booking: ${blockedMessage}`);
          } else {
            this.notes.push("Manual booking timed out before a confirmation signal appeared.");
          }
        } else if (result.result.status === "operator_skipped") {
          this.notes.push("Operator skipped the booking step.");
        } else {
          this.scheduling.booked = true;
          this.milestones.booking_confirmed = true;
          this.deps.state.transition("BOOKING_CONFIRMED", {
            url: page.url(),
            note: `${result.result.signal}: ${result.result.detail}`,
          });
        }
      }

      // Most funnels redirect to their own thank-you page after booking.
      if (this.scheduling.booked) {
        page = await this.waitForPostBookingRedirect(page);
        page = await this.finishPendingEmbeddedForm(page, gate);
      }
    } else {
      this.notes.push("No scheduling step in this funnel; going straight to the confirmation page.");
    }

    // --- Confirmation ------------------------------------------------
    this.deps.state.transition("ANALYZING_CONFIRMATION_PAGE", { url: page.url() });
    await waitForPageStable(page).catch(() => []);

    // Only call this a confirmation page if the funnel actually got there.
    const progressed = this.milestones.form_submitted || this.scheduling.booked;
    const isConfirmation = progressed || (await looksLikeConfirmation(page));
    const captured = await this.capture(page, isConfirmation ? "confirmation" : "intermediate", {
      embeddedText: true,
    });

    if (!captured) {
      this.confirmationReason = "the confirmation page could not be captured";
      this.status = "partial";
      return;
    }
    if (!isConfirmation) {
      this.confirmationReason = "the form was never submitted, so the funnel never reached a confirmation page";
      this.status = "partial";
      logger.warn("No confirmation page: the funnel did not progress past the form.");
      return;
    }

    this.confirmation = captured.analysis;
    this.milestones.confirmation_analyzed = true;
    logger.info(
      `Confirmation page analysed: ${captured.analysis.confirmation_details?.appointment.detected ? "appointment details found" : "no appointment details"}, ` +
        `${captured.analysis.detected_issues.length} issue(s)`,
    );
    if (this.scheduling.detected && !this.scheduling.booked) {
      this.confirmationReason = "captured the last page reached; the booking was not confirmed";
    }
  }

  /** Scrolls to the form (following one CTA hop at a time when needed). */
  private async locateForm(
    startPage: Page,
    startRecord: PageRecord,
  ): Promise<{ page: Page; record: PageRecord; form: FormRecord | null }> {
    let page = startPage;
    let record = startRecord;

    for (let hop = 0; hop <= MAX_FORM_HOPS; hop += 1) {
      const form = this.interactionEngine.pickForm(record);
      if (form) return { page, record, form };

      const scheduling = await detectScheduling(page, record);
      if (scheduling.detected) return { page, record, form: null };

      const cta = this.interactionEngine.pickCta(record, this.visited, { clicked: this.clickedCtas });
      if (!cta || hop === MAX_FORM_HOPS) return { page, record, form: null };

      this.clickedCtas.add(cta.text.trim().toLowerCase());
      logger.info(`No form on this page; following CTA "${cta.text}" to reach the form`);
      const clicked = await this.interactionEngine.clickCta(page, cta, record, this.sequence + 1);
      this.interactions.push(clicked.result);
      record.interaction_results.push(clicked.result);
      if (clicked.page !== page) this.network.attach(clicked.page);
      page = clicked.page;

      await waitForPageStable(page).catch(() => []);
      const captured = await this.capture(page, "intermediate");
      if (!captured) return { page, record, form: null };
      record = captured.record;
    }

    return { page, record, form: null };
  }

  /** Brings the form into view without interacting with its fields. */
  private async revealForm(page: Page, form: FormRecord): Promise<void> {
    const selector =
      form.method === "iframe"
        ? form.selector || 'iframe[src*="typeform"], iframe[src*="calendly"], iframe[src*="leadconnector"]'
        : form.selector;
    if (selector) {
      await page
        .locator(selector)
        .first()
        .scrollIntoViewIfNeeded({ timeout: 4000 })
        .catch(() => undefined);
    }
    await this.screenshots.capture(page, {
      step: this.sequence,
      pageType: form.type === "booking" ? "booking" : "application",
      kind: "form_ready",
      fullPage: false,
    });
  }

  /**
   * A Typeform can put its Calendly block mid-form and keep asking questions
   * after the booking. If an embedded form is still open, hand control back to
   * the human until the form itself finishes.
   */
  private async finishPendingEmbeddedForm(page: Page, gate: ManualGate): Promise<Page> {
    if (page.isClosed()) return page;

    // DOM-only check: events from earlier in the run say nothing about now.
    const status = await readEmbeddedFormStatus(page, {
      events: this.deps.events,
      sinceEventIndex: this.deps.events?.length ?? 0,
    });
    if (status.state !== "in_progress") {
      // The embed finished or is gone: the form itself is done.
      this.milestones.form_submitted = true;
      return page;
    }

    logger.info(`Embedded form still open after the booking: ${status.evidence}`);
    const result = await gate.waitForEmbeddedFormCompletion(page);
    this.recordGate(result.result);
    this.markFormSubmitted(result.result);
    if (result.result.status === "timeout") {
      this.notes.push("The embedded form was still open when the wait timed out; analysing the page as reached.");
    }
    this.network.attach(result.page);
    await waitForPageStable(result.page).catch(() => []);
    return result.page;
  }

  /**
   * Only genuine completion signals count as a submitted form. Reaching the
   * scheduler inside a multi-step embed does not.
   */
  private markFormSubmitted(result: ManualGateResult): void {
    const progressed = result.status === "detected" || result.status === "operator_confirmed";
    if (progressed && FORM_COMPLETION_SIGNALS.has(result.signal)) {
      this.milestones.form_submitted = true;
    }
  }

  /**
   * After a confirmed booking many funnels redirect to their own thank-you
   * page. Wait for that, but never require it.
   */
  private async waitForPostBookingRedirect(page: Page): Promise<Page> {
    const before = page.url();
    const contextPages = new Set(page.context().pages());
    await Promise.race([
      page.waitForURL((url) => !isSameDocument(before, url.toString()), { timeout: POST_BOOKING_REDIRECT_MS }),
      page.context().waitForEvent("page", { timeout: POST_BOOKING_REDIRECT_MS }),
    ]).catch(() => undefined);

    const popup = page
      .context()
      .pages()
      .find((candidate) => !contextPages.has(candidate) && !candidate.isClosed() && !isBrowserErrorUrl(candidate.url()));
    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
      logger.info(`Following post-booking tab ${popup.url()}`);
      this.network.attach(popup);
      return popup;
    }
    if (!isSameDocument(before, page.url())) {
      logger.info(`Post-booking redirect to ${page.url()}`);
    } else {
      logger.info("No post-booking redirect; the confirmation is shown in place.");
    }
    return page;
  }

  /* ------------------------------------------------------------------ *
   * Automatic mode (unchanged traversal, now analysed and state-tracked)
   * ------------------------------------------------------------------ */

  private async runAutomatic(startPage: Page): Promise<void> {
    const crawler = this.crawler;
    const interactions = this.interactionEngine;
    let page = startPage;
    const total = this.config.max_pages;

    for (let step = 1; step <= this.config.max_pages; step += 1) {
      const url = page.url();
      if (isBrowserErrorUrl(url)) {
        this.fail("navigation", `landed on a browser error page (${url})`, url);
        this.status = "partial";
        this.notes.push("Stopped: destination did not load");
        break;
      }
      const normalized = normalizeUrl(url);
      if (this.visited.has(normalized)) {
        this.notes.push(`Stopped: already visited ${normalized}`);
        break;
      }
      this.visited.add(normalized);

      logger.step(step, total, `Capturing page ${url}`);
      const role: PageRole = step === 1 ? "landing" : "intermediate";
      const captured = await this.capture(page, role);
      if (!captured) {
        this.status = "partial";
        break;
      }
      const record = captured.record;
      if (step === 1) {
        this.landing = captured.analysis;
        this.landingRecord = record;
        this.milestones.landing_analyzed = true;
      }

      logger.step(step, total, `Detecting page type: ${record.page_type} (${record.classification_confidence})`);
      logger.step(step, total, `Extracting forms (${record.forms.length} found)`);

      if (this.blocked) break;

      const form = interactions.pickForm(record);
      let advanced = false;
      let attemptedSubmit = false;

      const recaptureCheckpoint: CheckpointHandler = async (checkpoint: FunnelCheckpoint) => {
        try {
          if (page.isClosed()) return;
          logger.step(this.pages.length + 1, total, `Funnel checkpoint: ${checkpoint.label}`);
          await this.capture(page, checkpointRole(checkpoint), {
            pageType: checkpoint.pageType,
            funnelStage: checkpoint.label,
            fast: true,
            embeddedText: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Checkpoint ${checkpoint.label} skipped: ${message}`);
        }
      };

      const formKey = form ? formIdentity(form) : "";
      if (form && interactions.canSubmitForms() && !this.submittedForms.has(formKey)) {
        attemptedSubmit = true;
        this.milestones.form_located = true;
        logger.step(step, total, `Submitting ${form.type} form${form.method === "iframe" ? " (embedded)" : ""}`);
        const result = await interactions.submitForm(page, form, record, step, recaptureCheckpoint);
        record.interaction_results.push(result);
        this.interactions.push(result);
        const moved = !isSameDocument(result.before_url, result.after_url);
        const progressed = result.success || moved;
        if (progressed) {
          this.submittedForms.add(formKey);
          this.milestones.form_submitted = true;
          logger.step(
            step,
            total,
            moved ? `Redirect detected: ${result.after_url}` : "Form step completed; recapturing next funnel state",
          );
          const nextPage = await this.followPostSubmitPage(page, result.before_url);
          if (nextPage !== page) {
            this.network.attach(nextPage);
            page = nextPage;
          }
          await waitForPageStable(page).catch(() => []);
          await this.screenshots.capture(page, {
            step: Math.min(this.pages.length + 1, this.config.max_pages),
            pageType: record.page_type,
            kind: "after_navigation",
            fullPage: false,
          });
          advanced = this.markAdvance(normalized, !isSameDocument(url, page.url()));
        } else {
          logger.warn(result.result);
          this.notes.push(result.result);
          this.status = "partial";
        }
      } else if (form && !interactions.canSubmitForms()) {
        const skipped: InteractionResult = {
          action: "submit_form",
          element: form.type,
          success: false,
          before_url: url,
          after_url: url,
          result: identityIsUsable(this.config.test_identity)
            ? "form submission disabled by configuration"
            : "form not submitted; no test email/phone supplied",
          timestamp: new Date().toISOString(),
        };
        record.interaction_results.push(skipped);
        this.interactions.push(skipped);
        this.notes.push(skipped.result);
      } else if (form?.type === "checkout" && !this.config.submit_checkout) {
        this.notes.push("Checkout form detected but not submitted (submit_checkout=false)");
      }

      if (!advanced && !attemptedSubmit) {
        const skipApply = Boolean(
          form && form.field_count > 0 && (form.method === "iframe" || form.type === "application"),
        );
        const cta = interactions.pickCta(record, this.visited, {
          clicked: this.clickedCtas,
          skipApply,
        });
        const shouldClickCta =
          cta && !["thank_you", "login", "calendar", "booking", "checkout"].includes(record.page_type);

        if (shouldClickCta && cta) {
          this.clickedCtas.add(cta.text.trim().toLowerCase());
          logger.step(step, total, `Clicking CTA: ${cta.text}`);
          const { result, page: nextPage } = await interactions.clickCta(page, cta, record, step);
          record.interaction_results.push(result);
          this.interactions.push(result);
          if (nextPage !== page) this.network.attach(nextPage);
          page = nextPage;
          const moved = !isSameDocument(result.before_url, result.after_url);
          const inPage = result.result.startsWith("in-page reveal");
          await waitForPageStable(page).catch(() => []);
          await this.screenshots.capture(page, {
            step: Math.min(step + 1, this.config.max_pages),
            pageType: record.page_type,
            kind: inPage ? "after_in_page" : "after_navigation",
            fullPage: false,
          });
          if (moved) {
            advanced = this.markAdvance(normalized, true);
          } else if (inPage) {
            this.notes.push("In-page CTA reveal; recapturing newly shown content");
            advanced = this.markAdvance(normalized, false);
          }
        }
      }

      if (!advanced) {
        this.notes.push(`No further funnel action taken on ${record.page_type} (${url})`);
        break;
      }
    }

    await this.finishAutomatic();
  }

  /** Picks the confirmation page out of what automatic mode reached. */
  private async finishAutomatic(): Promise<void> {
    const confirmation = [...this.analyses]
      .reverse()
      .find((analysis) =>
        ["confirmation", "thank_you"].includes(analysis.page_information.page_type) ||
        analysis.page_information.page_role === "confirmation",
      );
    if (confirmation) {
      this.confirmation = { ...confirmation };
      this.confirmation.page_information.page_role = "confirmation";
      this.confirmation.confirmation_details = this.confirmation.confirmation_details ?? null;
      this.milestones.confirmation_analyzed = true;
    } else {
      this.confirmationReason = "automatic mode did not reach a confirmation page";
    }
  }

  /* ------------------------------------------------------------------ *
   * Shared capture + analysis
   * ------------------------------------------------------------------ */

  /**
   * One entry per meaningful funnel state, not per capture. Embedded funnels
   * keep the same URL across steps, so the state and stage disambiguate them;
   * a repeat of the same URL in the same state is collapsed.
   */
  private recordFunnelStep(record: PageRecord, role: PageRole): void {
    const stage = record.funnel_stage || record.page_type.replace(/_/g, " ");
    const label = `${ROLE_LABEL[role]} — ${stage}`;
    const last = this.funnelPath[this.funnelPath.length - 1];
    if (last && isSameDocument(last.url, record.url) && last.label === label) return;
    this.funnelPath.push({
      step: this.funnelPath.length + 1,
      url: record.url,
      page_type: record.page_type,
      label,
      page_role: role,
      run_state: this.deps.state.state,
    });
  }

  private async capture(
    page: Page,
    role: PageRole,
    opts?: {
      pageType?: PageRecord["page_type"];
      funnelStage?: string;
      fast?: boolean;
      embeddedText?: boolean;
    },
  ): Promise<{ record: PageRecord; analysis: PageAnalysis } | null> {
    const mark = this.network.mark();
    this.sequence += 1;

    let record: PageRecord;
    try {
      record = await this.crawler.crawl(page, this.sequence, this.errors, {
        pageType: opts?.pageType,
        funnelStage: opts?.funnelStage,
        fast: opts?.fast,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail("extraction", message, page.isClosed() ? undefined : page.url());
      this.sequence -= 1;
      return null;
    }

    if (opts?.embeddedText || role === "confirmation") {
      record.embedded_text = await readEmbeddedText(page).catch(() => []);
    }

    const blocker = detectBlocker(record.title, record.visible_text);
    if (blocker) {
      this.blocked = true;
      this.status = "blocked";
      this.notes.push(blocker);
    }

    const scheduling: SchedulingPresence | null = await detectScheduling(page, record).catch(() => null);
    // A scheduler found past the landing page counts as a scheduling step.
    if (scheduling?.detected && role !== "landing") {
      this.milestones.scheduling_detected = true;
      if (!this.scheduling.detected) {
        this.scheduling = { detected: true, provider: scheduling.provider, booked: this.scheduling.booked };
      }
    }
    const analysis = analyzePage({
      record,
      role,
      sequence: this.sequence,
      metadata: this.deps.metadata,
      network: this.network.since(mark),
      blocker,
      scheduling,
    });

    this.pages.push(record);
    this.analyses.push(analysis);
    this.recordFunnelStep(record, role);
    this.deps.onPageAnalyzed?.(analysis);
    return { record, analysis };
  }

  private recordGate(result: ManualGateResult): void {
    this.manualGates.push(result);
    this.interactions.push({
      action: result.kind === "form_submission" ? "manual_form_submission" : "manual_booking",
      element: result.kind,
      success: result.status === "detected" || result.status === "operator_confirmed",
      before_url: result.url_before,
      after_url: result.url_after,
      result: `${result.status} (${result.signal}): ${result.detail}`,
      timestamp: result.ended_at,
    });
  }

  private async followPostSubmitPage(current: Page, beforeUrl: string): Promise<Page> {
    const alreadyMoved = !isSameDocument(current.url(), beforeUrl);
    const alreadyPopup = current
      .context()
      .pages()
      .some((candidate) => !candidate.isClosed() && candidate !== current && !isSameDocument(candidate.url(), beforeUrl));
    if (!alreadyMoved && !alreadyPopup) {
      await Promise.race([
        current.waitForURL((url) => !isSameDocument(beforeUrl, url.toString()), { timeout: 20000 }),
        current.context().waitForEvent("page", { timeout: 20000 }),
      ]).catch(() => undefined);
    }
    const opened = current
      .context()
      .pages()
      .filter((candidate) => !candidate.isClosed() && candidate !== current)
      .reverse();
    for (const candidate of opened) {
      const href = candidate.url();
      if (!isBrowserErrorUrl(href) && !isSameDocument(href, beforeUrl)) {
        logger.info(`Following post-submit tab ${href}`);
        await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
        return candidate;
      }
    }
    if (!isSameDocument(current.url(), beforeUrl)) {
      logger.info(`Following post-submit redirect ${current.url()}`);
    }
    return current;
  }

  private markAdvance(normalizedUrl: string, movedToNewDocument: boolean): boolean {
    if (movedToNewDocument) {
      this.sameUrlAdvances = 0;
      return true;
    }
    if (this.sameUrlAdvances >= 5) {
      this.notes.push("Stopped: too many same-document advances");
      return false;
    }
    this.visited.delete(normalizedUrl);
    this.sameUrlAdvances += 1;
    return true;
  }

  private fail(stage: string, error: string, url?: string): void {
    this.errors.push({
      stage,
      error,
      url,
      timestamp: new Date().toISOString(),
    });
    logger.error(`${stage}: ${error}`);
  }

  private outcome(startedAt: string): NavigatorOutcome {
    return {
      report: this.report(startedAt),
      analyses: this.analyses,
      landing: this.landing,
      confirmation: this.confirmation,
      confirmation_reason: this.confirmationReason,
      manual_gates: this.manualGates,
      scheduling: this.scheduling,
      milestones: this.milestones,
      landing_record: this.landingRecord,
      blocked: this.blocked,
    };
  }

  private report(startedAt: string): CrawlReport {
    return {
      crawl_id: this.crawlId,
      start_url: this.config.start_url,
      status: this.status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      device: this.config.device,
      business: { name: null, owner: null },
      funnel_path: this.funnelPath,
      pages: this.pages,
      interactions: this.interactions,
      screenshots: this.screenshots.all(),
      errors: this.errors,
      notes: this.notes,
    };
  }
}

const CONFIRMATION_PAGE_TEXT =
  /\b(thank you|you are scheduled|you'?re scheduled|you'?re all set|is scheduled|booking confirmed|application (was |has been )?received|check your (email|inbox))\b/i;

/** Last-resort check for funnels that confirm without any detected transition. */
async function looksLikeConfirmation(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const text = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  return CONFIRMATION_PAGE_TEXT.test(text);
}

function checkpointRole(checkpoint: FunnelCheckpoint): PageRole {
  switch (checkpoint.kind) {
    case "calendar":
    case "calendar_questions":
      return "scheduling";
    case "booking_confirmation":
    case "form_complete":
      return "confirmation";
    default:
      return "form";
  }
}

function formIdentity(form: { action: string | null; selector: string | null; type: string }): string {
  const action = form.action || "";
  const typeform = action.match(/typeform\.com\/to\/([^?#/]+)/i);
  if (typeform) return `typeform:${typeform[1]}`;
  try {
    return new URL(action).origin + new URL(action).pathname;
  } catch {
    return action || form.selector || form.type;
  }
}
