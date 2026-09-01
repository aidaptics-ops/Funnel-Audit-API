import type { Browser } from "playwright";
import { ANALYSIS_SCHEMA_VERSION, type LandingAnalysis, type VideoEntry } from "../analysis/landing_types.js";
import type { BrowserConfig } from "../types/index.js";
import { captureLandingPage, type CaptureResult } from "./capture.js";
import type { LinkCheckOptions } from "./link_checker.js";

import { buildFunnel } from "../analysis/sections/funnel.js";
import { buildPage } from "../analysis/sections/page.js";
import { buildHeadings } from "../analysis/sections/headings.js";
import { buildHero } from "../analysis/sections/hero.js";
import { buildCopy } from "../analysis/sections/copy.js";
import { buildVideos } from "../analysis/sections/videos.js";
import { buildVsl } from "../analysis/sections/vsl.js";
import { associateCtasWithForms, buildCtas, ctaConsistency } from "../analysis/sections/ctas.js";
import { buildForms } from "../analysis/sections/forms.js";
import { buildTestimonials } from "../analysis/sections/testimonials.js";
import { buildSocialProof } from "../analysis/sections/social_proof.js";
import { buildOffer } from "../analysis/sections/offer.js";
import { buildGuarantees } from "../analysis/sections/guarantees.js";
import { buildPricing } from "../analysis/sections/pricing.js";
import { buildUrgency } from "../analysis/sections/urgency.js";
import { buildNavigation } from "../analysis/sections/navigation.js";
import { buildLinks } from "../analysis/sections/links.js";
import { buildTracking } from "../analysis/sections/tracking.js";
import { buildSeo } from "../analysis/sections/seo.js";
import { buildTechnical } from "../analysis/sections/technical.js";
import { detectObservedIssues } from "../analysis/observed_issues.js";

export interface AnalyzeLandingOptions {
  url: string;
  jobId: string;
  browser: Browser;
  config: BrowserConfig;
  checkMobileViewport: boolean;
  linkCheck: LinkCheckOptions;
  /**
   * The SSRF guard applied to every main-frame navigation, including the
   * redirects Chromium follows on its own. Injected so the pipeline never reads
   * deployment configuration. When absent it falls back to the guard the link
   * checker was given: the same check, so the fallback can only ever be as
   * strict as the caller already is - never permissive.
   */
  isAllowedUrl?: (url: string) => boolean;
  /** Hard ceiling for the capture. Defaults to 3x the navigation timeout. */
  deadlineMs?: number;
  /** Photograph the page as well as reading it. Off unless asked for. */
  screenshot?: boolean;
}

/** Loads one landing page and turns it into the structured analysis. */
export async function analyzeLandingPage(options: AnalyzeLandingOptions): Promise<LandingAnalysis> {
  const startedAt = Date.now();
  const capture = await captureLandingPage({
    jobId: options.jobId,
    url: options.url,
    browser: options.browser,
    config: options.config,
    checkMobileViewport: options.checkMobileViewport,
    screenshot: options.screenshot === true,
    linkCheck: options.linkCheck,
    isAllowedUrl: options.isAllowedUrl ?? options.linkCheck.isAllowedUrl,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });

  return composeAnalysis(capture, Date.now() - startedAt);
}

/**
 * Pure composition of the sections, split out so it can be unit-tested against
 * a synthetic capture without launching a browser.
 */
export function composeAnalysis(capture: CaptureResult, durationMs: number): LandingAnalysis {
  const headings = buildHeadings(capture);
  const videos = buildVideos(capture);
  const ctas = buildCtas(capture);
  const forms = buildForms(capture);
  // A form's submit button is that form's CTA: pair them before anything
  // reasons about "is there a call to action above the fold".
  associateCtasWithForms(
    ctas,
    forms.map((form) => ({ y: form.location.y, cta_text: form.cta_text })),
  );
  const navigation = buildNavigation(capture);
  const vsl = buildVsl(capture, videos, ctas, navigation.nav_item_count);
  const hero = buildHero(capture, ctas, videos);
  const testimonials = buildTestimonials(capture);
  const socialProof = buildSocialProof(capture, testimonials);
  const guarantees = buildGuarantees(capture);
  const pricing = buildPricing(capture);
  const offer = buildOffer(capture, ctas, pricing, guarantees);

  const withoutIssues: Omit<LandingAnalysis, "observed_issues"> = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    screenshot: capture.screenshot,
    analyzed_at: new Date().toISOString(),
    duration_ms: durationMs,
    funnel: buildFunnel(capture),
    page: buildPage(capture),
    hero,
    headings,
    copy: buildCopy(capture),
    videos,
    vsl,
    ctas,
    forms,
    testimonials,
    social_proof: socialProof,
    offer,
    guarantees,
    pricing,
    urgency: buildUrgency(capture),
    navigation,
    links: buildLinks(capture),
    tracking: buildTracking(capture),
    seo: buildSeo(capture),
    technical: buildTechnical(capture),
    summary: {
      ctas: {
        total: ctas.length,
        above_fold: ctas.filter((cta) => cta.above_fold).length,
        primary_text: ctas.find((cta) => cta.is_primary)?.text ?? null,
        unique_destinations: new Set(
          ctas.map((cta) => cta.destination.url).filter((url): url is string => Boolean(url)),
        ).size,
        consistency: ctaConsistency(ctas),
      },
      forms: {
        total: forms.length,
        providers: [...new Set(forms.map((form) => form.provider))],
        above_fold: forms.filter((form) => form.location.above_fold).length,
      },
      videos: videoCounts(videos),
      proof: {
        testimonials: testimonials.length,
        logos: socialProof.client_logos.length,
        ratings: socialProof.ratings.length,
      },
      issues: { total: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 } },
    },
  };

  const issues = detectObservedIssues({ capture, analysis: withoutIssues });
  withoutIssues.summary.issues = {
    total: issues.length,
    by_severity: {
      critical: issues.filter((issue) => issue.severity === "critical").length,
      high: issues.filter((issue) => issue.severity === "high").length,
      medium: issues.filter((issue) => issue.severity === "medium").length,
      low: issues.filter((issue) => issue.severity === "low").length,
      informational: issues.filter((issue) => issue.severity === "informational").length,
    },
  };

  return { ...withoutIssues, observed_issues: issues };
}

/**
 * One reconciled set of video counts. Sections used to disagree — a page could
 * report 8 players in one field and 1 in another with nothing explaining the
 * gap. Every consumer now reads these, and `total`/`above_fold` are kept as
 * aliases so existing clients do not break.
 */
function videoCounts(videos: VideoEntry[]): LandingAnalysis["summary"]["videos"] {
  const visible = videos.filter((video) => video.visible);
  const aboveFold = videos.filter((video) => video.above_fold && video.visible);
  // Analyzable = we could read enough (a known provider and a real box) to say
  // anything about it, which is what the VSL determination consumes.
  const analyzable = visible.filter(
    (video) => video.provider !== "unknown" && (video.width ?? 0) > 0 && (video.height ?? 0) > 0,
  );

  return {
    dom_count: videos.length,
    visible_count: visible.length,
    above_fold_count: aboveFold.length,
    analyzable_count: analyzable.length,
    total: videos.length,
    above_fold: aboveFold.length,
    providers: [...new Set(videos.map((video) => video.provider))],
  };
}
