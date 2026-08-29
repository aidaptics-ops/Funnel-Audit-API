import type { Page } from "playwright";
import type { CrawlError, PageRecord, PageType, TechnicalEvent } from "../types/index.js";
import { extractPageEvidence } from "../extraction/index.js";
import { logger } from "../logging/logger.js";
import type { ScreenshotManager } from "../screenshots/screenshot_manager.js";
import type { NetworkCapture } from "./network_capture.js";
import { detectBlocker, dismissObstructions, waitForPageStable } from "./page_stability.js";

export class PageCrawler {
  constructor(
    private readonly screenshots: ScreenshotManager,
    private readonly network?: NetworkCapture,
  ) {}

  async crawl(
    page: Page,
    step: number,
    errors: CrawlError[],
    opts?: { pageType?: PageType; funnelStage?: string; quiet?: boolean; fast?: boolean },
  ): Promise<PageRecord> {
    const technical: TechnicalEvent[] = [];
    const now = () => new Date().toISOString();

    // `fast` captures a live checkpoint mid-flow without stalling the funnel.
    const waitEvents = opts?.fast ? ["skipped_for_checkpoint"] : await waitForPageStable(page);
    technical.push({
      type: "wait",
      message: waitEvents.join(", "),
      timestamp: now(),
      url: page.url(),
    });

    if (!opts?.quiet && !opts?.fast) {
      const dismissed = await dismissObstructions(page);
      if (dismissed.length) {
        technical.push({
          type: "popup_dismiss",
          message: dismissed.join(", "),
          timestamp: now(),
          url: page.url(),
        });
        await waitForPageStable(page).catch(() => []);
      }
    }

    let extracted;
    try {
      extracted = await extractPageEvidence(page, {
        typeformPayloads: this.network?.typeformPayloads,
        classificationHint: opts?.pageType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ stage: "extraction", error: message, url: page.url(), timestamp: now() });
      logger.warn(`Extraction failed: ${message}`);
      extracted = fallbackRecord(page);
    }

    const pageType: PageType = opts?.pageType || extracted.record.page_type;
    extracted.record.page_type = pageType;
    extracted.record.funnel_stage = opts?.funnelStage || defaultFunnelStage(pageType);
    const screenshots = [];

    const viewport = await this.screenshots.capture(page, {
      step,
      pageType,
      kind: "viewport",
      fullPage: false,
    });
    if (viewport) screenshots.push(viewport);
    else {
      errors.push({
        stage: "screenshot",
        error: "viewport screenshot failed",
        url: page.url(),
        timestamp: now(),
      });
    }

    const full = opts?.fast
      ? null
      : await this.screenshots.capture(page, {
          step,
          pageType,
          kind: "full",
          fullPage: true,
        });
    if (full) screenshots.push(full);

    if (opts?.fast) {
      return {
        ...extracted.record,
        screenshots,
        technical_events: technical,
        interaction_results: [],
      };
    }

    if (pageType === "confirmation" || pageType === "thank_you") {
      const extra = await this.screenshots.capture(page, {
        step,
        pageType,
        kind: pageType,
        fullPage: true,
      });
      if (extra) screenshots.push(extra);
    }
    if (pageType === "one_time_offer") {
      const extra = await this.screenshots.capture(page, {
        step,
        pageType,
        kind: "oto",
        fullPage: true,
      });
      if (extra) screenshots.push(extra);
    }
    if (pageType === "application") {
      const extra = await this.screenshots.capture(page, {
        step,
        pageType,
        kind: "application",
        fullPage: true,
      });
      if (extra) screenshots.push(extra);
    }
    if (pageType === "booking" || pageType === "calendar") {
      const extra = await this.screenshots.capture(page, {
        step,
        pageType,
        kind: "booking",
        fullPage: true,
      });
      if (extra) screenshots.push(extra);
    }

    const visibleDialog = extracted.record.iframes.length
      ? null
      : await page
          .locator("[role='dialog']:visible, dialog[open]")
          .first()
          .isVisible()
          .catch(() => false);
    if (visibleDialog) {
      const modal = await this.screenshots.capture(page, {
        step,
        pageType,
        kind: "modal",
        fullPage: false,
      });
      if (modal) screenshots.push(modal);
      technical.push({
        type: "modal",
        message: "visible dialog/modal detected",
        timestamp: now(),
        url: page.url(),
      });
    }

    const blocker = detectBlocker(extracted.record.title, extracted.record.visible_text);
    if (blocker) {
      errors.push({ stage: "navigation", error: blocker, url: page.url(), timestamp: now() });
      technical.push({ type: "blocked", message: blocker, timestamp: now(), url: page.url() });
    }

    if (extracted.record.above_the_fold) {
      extracted.record.above_the_fold.viewport_screenshot = viewport?.filename ?? null;
    }

    return {
      ...extracted.record,
      screenshots,
      technical_events: technical,
      interaction_results: [],
    };
  }
}

function fallbackRecord(page: Page) {
  return {
    record: {
      url: page.url(),
      canonical_url: null,
      page_type: "unknown" as const,
      funnel_stage: "unknown",
      classification_confidence: 0,
      classification_evidence: ["extraction failed"],
      title: "",
      meta_description: null,
      timestamp: new Date().toISOString(),
      headings: [],
      subheadings: [],
      paragraphs: [],
      visible_text: "",
      buttons: [],
      links: [],
      forms: [],
      videos: [],
      images: [],
      ctas: [],
      pricing: [],
      testimonials: [],
      faq_sections: [],
      urgency_elements: [],
      social_proof: [],
      benefit_stack: [],
      objection_handling: [],
      attendance_bonuses: [],
      one_time_offer: null,
      confirmation: null,
      application_friction: null,
      cta_benefit_relationships: [],
      proof_placement: [],
      above_the_fold: {
        hero_heading: null,
        hero_subheading: null,
        primary_cta: null,
        primary_offer: null,
        first_visible_proof: null,
        first_visible_objection_handling: null,
        first_visible_price: null,
        first_visible_video: null,
        viewport_screenshot: null,
      },
      iframes: [],
      json_ld: [],
    },
    snapshotUrl: page.url(),
  };
}

function defaultFunnelStage(pageType: PageType): string {
  switch (pageType) {
    case "vsl":
      return "VSL";
    case "application":
      return "Application";
    case "optin":
      return "Opt-in";
    case "webinar_registration":
      return "Webinar Registration";
    case "calendar":
      return "Calendly";
    case "booking":
      return "Calendly Questions";
    case "checkout":
      return "Checkout";
    case "one_time_offer":
      return "OTO";
    case "confirmation":
      return "Booking Confirmation";
    case "thank_you":
      return "Confirmation Assets";
    case "training":
      return "Training";
    default:
      return pageType.replace(/_/g, " ");
  }
}
