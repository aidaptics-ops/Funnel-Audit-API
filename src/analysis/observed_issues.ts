import type { CaptureResult } from "../pipeline/capture.js";
import type { ImageRecord } from "../types/index.js";
import type {
  CtaEntry,
  IssueCategory,
  IssueSeverity,
  LandingAnalysis,
  ObservedIssue,
} from "./landing_types.js";
import { buildAuditContext, severityForMissing, withArticle, type AuditContext } from "./audit/context.js";
import { SEVERITY_RANK, downgrade, temperByConfidence } from "./audit/severity.js";

export interface IssueInput {
  capture: CaptureResult;
  analysis: Omit<LandingAnalysis, "observed_issues">;
}

type Analysis = Omit<LandingAnalysis, "observed_issues">;

const EVIDENCE_CHARS = 160;
const MAX_EVIDENCE_LINES = 8;

/** Hosts that exist only to take a payment, so their presence is a checkout. */
const CHECKOUT_HOSTS =
  /(^|\.)(checkout|buy)\.stripe\.com|(^|\.)paypal\.com|(^|\.)paddle\.com|(^|\.)lemonsqueezy\.com|(^|\.)gumroad\.com|(^|\.)thrivecart\.com|(^|\.)samcart\.com|(^|\.)snipcart\.com|(^|\.)chargebee\.com|(^|\.)recurly\.com|(^|\.)fastspring\.com|(^|\.)2checkout\.com|(^|\.)checkout\.square\.site/i;

/** Path segments that name a checkout step on any host. */
const CHECKOUT_PATHS = /\/(checkout|cart|order[-_]?form|purchase|payment)(\/|\?|#|$)/i;

/** Funnel types where a long navigation menu contradicts the page's own goal. */
const FOCUSED_FUNNELS = new Set(["optin", "lead_magnet", "vsl", "application"]);

const SEVERITY_ORDER = SEVERITY_RANK;

interface BrokenImage {
  src: string;
  alt: string | null;
  width: number;
  height: number;
}

interface IssueFacts {
  aboveFoldCtas: CtaEntry[];
  /** CTA destination kinds that are, on their own, a way to convert. */
  conversionCtas: CtaEntry[];
  checkoutSignals: string[];
  destinationHistogram: string;
  /** Images that failed to load AND occupy a box a visitor could see. */
  brokenImages: BrokenImage[];
  visibleImages: ImageRecord[];
  visibleImagesWithoutAlt: ImageRecord[];
}

interface IssueContext {
  capture: CaptureResult;
  a: Analysis;
  facts: IssueFacts;
  /** funnel type, page type, conversion goal and what they imply. */
  audit: AuditContext;
}

interface IssueRule {
  id: string;
  /**
   * A literal for findings whose seriousness does not depend on the funnel, or
   * a function for the ones that do. The function receives the same context the
   * evidence did and must return a severity it can justify.
   */
  severity: IssueSeverity | ((ctx: IssueContext) => IssueSeverity);
  category: IssueCategory;
  title: string;
  description: string | ((ctx: IssueContext) => string);
  recommendation: string | ((ctx: IssueContext) => string);
  /** Non-empty return means the rule fired. Every line is an observed value. */
  evidence: (ctx: IssueContext) => string[];
  /** What this observation means for THIS funnel. Optional. */
  impact?: (ctx: IssueContext) => string | undefined;
  /** How sure we are the observation is a real problem, not just an absence. */
  confidence?: (ctx: IssueContext) => number;
  /** One line explaining a context-driven severity, surfaced in the payload. */
  rationale?: (ctx: IssueContext) => string | undefined;
}

export function detectObservedIssues(input: IssueInput): ObservedIssue[] {
  const ctx: IssueContext = {
    capture: input.capture,
    a: input.analysis,
    facts: deriveFacts(input),
    audit: buildAuditContext(input.analysis),
  };

  const issues: ObservedIssue[] = [];
  for (const rule of RULES) {
    const evidence = rule.evidence(ctx).map((line) => line.trim()).filter(Boolean);
    if (!evidence.length) continue;
    const severity = typeof rule.severity === "function" ? rule.severity(ctx) : rule.severity;
    const impact = rule.impact?.(ctx);
    const rationale = rule.rationale?.(ctx);
    issues.push({
      id: rule.id,
      severity,
      category: rule.category,
      title: rule.title,
      description: typeof rule.description === "function" ? rule.description(ctx) : rule.description,
      evidence: evidence.slice(0, MAX_EVIDENCE_LINES),
      recommendation:
        typeof rule.recommendation === "function" ? rule.recommendation(ctx) : rule.recommendation,
      ...(impact ? { impact } : {}),
      ...(rule.confidence ? { confidence: Number(rule.confidence(ctx).toFixed(2)) } : {}),
      ...(rationale ? { severity_rationale: rationale } : {}),
    });
  }

  return issues.sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    return bySeverity !== 0 ? bySeverity : left.id.localeCompare(right.id);
  });
}

/* ------------------------ funnel-aware offer clarity ---------------------- */

type OfferPiece = "product" | "audience" | "price" | "proof" | "cta" | "benefits";

/**
 * The offer section reports every element it could not read. Whether a missing
 * element is a *problem* depends on the funnel: an application page is not
 * supposed to quote a price, and a lead magnet has none to quote.
 */
function expectationFor(audit: AuditContext, piece: OfferPiece): "expected" | "optional" | "irrelevant" {
  switch (piece) {
    case "price":
      return audit.expects.price;
    case "proof":
      return audit.expects.proof;
    case "audience":
      return audit.expects.audience;
    case "benefits":
      return audit.expects.benefits;
    // A page that names neither what it offers nor what to do is unclear on
    // any funnel type.
    case "product":
    case "cta":
      return "expected";
    default:
      return "optional";
  }
}

function missingPieces(a: Analysis): OfferPiece[] {
  const clarity = a.offer.clarity;
  if (clarity.status !== "detected") return [];
  return clarity.value.missing.filter((piece): piece is OfferPiece =>
    ["product", "audience", "price", "proof", "cta", "benefits"].includes(piece),
  );
}

/** Missing elements this funnel type is actually expected to state. */
function relevantMissing(a: Analysis, audit: AuditContext): OfferPiece[] {
  return missingPieces(a).filter((piece) => expectationFor(audit, piece) !== "irrelevant");
}

/** Missing elements deliberately ignored because this funnel does not need them. */
function ignoredMissing(a: Analysis, audit: AuditContext): OfferPiece[] {
  return missingPieces(a).filter((piece) => expectationFor(audit, piece) === "irrelevant");
}

/** Plain-language name for what the page is asking the visitor to do. */
function goalPhrase(audit: AuditContext): string {
  switch (audit.conversion_goal) {
    case "book_a_call":
      return "book a call";
    case "opt_in":
      return "hand over an email address";
    case "register_for_webinar":
      return "register";
    case "submit_application":
      return "submit an application";
    case "purchase":
      return "buy";
    case "download_lead_magnet":
      return "download the resource";
    case "contact":
      return "get in touch";
    case "watch_video":
      return "watch the video";
    default:
      return "act";
  }
}

/* --------------------------------- rules --------------------------------- */

const RULES: IssueRule[] = [
  {
    id: "NO_CTA_DETECTED",
    severity: "critical",
    category: "cta",
    title: "No call to action was found on the page",
    description:
      "The CTA detector found no button, link or submit control on the rendered page that asks the visitor to take an action.",
    recommendation:
      "Add an explicit action control with an action-oriented label, and place one instance within the first viewport.",
    evidence: ({ a, capture }) => {
      if (a.ctas.length > 0) return [];
      // A form is itself somewhere to act, so claiming no action exists would
      // contradict the page.
      if (a.forms.length > 0 || a.page.dom.forms > 0) return [];
      // The CTA detector needs a readable label. An image or icon control
      // carries none, so a visible button, submit input or [role=button] that
      // produced no CTA is a limit of the detector, not a fact about the page.
      const controls = visibleActionControls(capture);
      if (controls.length > 0) return [];
      const lines = [
        "0 CTAs detected: 0 <form> elements and 0 visible button, submit or [role=button] controls in the rendered DOM",
        `${a.page.dom.links} link(s) were present on the page, none of which carried an action label`,
      ];
      const heading = a.headings.find((entry) => entry.visible);
      if (heading) lines.push(`Page headline observed: ${quote(heading.text)}`);
      return lines;
    },
  },

  {
    id: "BROKEN_CTA_DESTINATION",
    severity: "critical",
    category: "cta",
    title: "A call to action has no working destination",
    description:
      "At least one CTA points at a URL that answered with an error status when it was requested, so a visitor who follows it lands on an error page.",
    recommendation:
      "Point each CTA at a URL that returns a success response.",
    evidence: ({ a }) => {
      const lines: string[] = [];

      // A CTA whose behaviour lives in a click handler is deliberately not
      // reported: the analyser never clicks, so it cannot know whether the
      // handler works. Only a destination that answered with an error is
      // observed evidence of a break.
      for (const cta of a.ctas) {
        if (!isBrokenDestination(cta.destination)) continue;
        lines.push(
          `CTA ${quote(cta.text)} -> ${trim(cta.destination.url ?? cta.href ?? "")} returned status ${cta.destination.status}`,
        );
      }

      return lines.slice(0, 5);
    },
  },

  {
    id: "NOINDEX_DETECTED",
    severity: "critical",
    category: "seo",
    title: "The page tells search engines not to index it",
    description:
      "The rendered document carries a robots directive that excludes the page from search engine indexes.",
    recommendation:
      "Remove the noindex directive if this page is meant to receive organic or shared traffic.",
    evidence: ({ a }) => {
      if (a.seo.robots.indexable !== false) return [];
      // The directive text is the whole of the evidence; without it the URL
      // alone would not show the page excludes itself.
      const content = a.seo.robots.content;
      if (!content) return [];
      return [
        `Robots directive content: ${quote(content)}`,
        `Observed on ${trim(a.page.final_url, 120)}`,
      ];
    },
  },

  {
    id: "NOT_HTTPS",
    severity: "critical",
    category: "technical",
    title: "The page was served over plain HTTP",
    description:
      "The final URL after redirects uses the http scheme, so the page and anything submitted from it travel unencrypted.",
    recommendation:
      "Serve the page over HTTPS and redirect the http URL to it.",
    evidence: ({ a }) => {
      if (a.technical.https !== false) return [];
      const url = a.page.final_url;
      // Only report when the URL itself confirms it; never on the flag alone.
      if (!/^http:\/\//i.test(url)) return [];
      return [`Final URL after ${a.technical.redirect_count} redirect(s): ${trim(url, 120)}`];
    },
  },

  {
    id: "BROKEN_IMAGES",
    severity: "high",
    category: "media",
    title: "Images on the page failed to load",
    description:
      "One or more <img> elements that occupy a visible box on the page finished loading with no intrinsic size, meaning the browser could not fetch or decode the file. Data URIs, SVGs and images too small to be seen are excluded, because no-intrinsic-size is normal for those.",
    recommendation: "Fix or remove the image sources listed below.",
    evidence: ({ facts }) => {
      const broken = facts.brokenImages;
      if (!broken.length) return [];
      const lines = [`${broken.length} image(s) with a rendered box failed to load`];
      for (const image of broken.slice(0, 3)) {
        const alt = image.alt ? ` (alt: ${quote(image.alt)})` : "";
        lines.push(
          `Failed image src: ${trim(image.src, 120)}${alt}, rendered at ${image.width}x${image.height}px`,
        );
      }
      return lines;
    },
  },

  {
    id: "NO_ANALYTICS_DETECTED",
    // "Not observed" is not "not installed". Consent-gated, server-side and
    // tag-manager-injected analytics are all invisible to a single render.
    severity: ({ audit }) => (audit.conversion_path === "none" ? "low" : "medium"),
    category: "tracking",
    title: "No analytics vendor was observable during this render",
    description:
      "No recognisable analytics vendor was observable during this rendered session. Analytics may still be present: scripts can be consent-gated, injected by a tag manager after the observation window, served first-party, or implemented server-side.",
    recommendation:
      "Confirm directly in your analytics tool that this page reports traffic. If it genuinely has no measurement, add it before spending on traffic.",
    impact: ({ audit }) =>
      `Without measurement, changes to ${withArticle(audit.label)} cannot be evaluated. Treat this as a prompt to verify, not as proof of absence.`,
    confidence: () => 0.4,
    rationale: () =>
      "Capped at medium: a single render cannot prove analytics is absent (consent gating, server-side and delayed injection are all invisible here).",
    evidence: ({ a }) => {
      if (a.tracking.has_analytics) return [];
      const lines = [
        `No analytics vendor matched among ${a.tracking.script_count} script element(s) on the rendered page`,
      ];
      const hosts = a.tracking.third_party_script_hosts;
      lines.push(
        hosts.length
          ? `Third-party script hosts observed: ${hosts.slice(0, 6).join(", ")}`
          : "No third-party script hosts were observed",
      );
      if (a.tracking.has_tag_manager) {
        const managers = a.tracking.detected
          .filter((vendor) => vendor.category === "tag_manager")
          .map((vendor) => vendor.vendor);
        lines.push(
          `A tag manager was detected (${managers.join(", ") || "unnamed"}); tags it injects are not visible in the rendered markup`,
        );
      }
      const others = a.tracking.detected.map((vendor) => `${vendor.vendor} (${vendor.category})`);
      if (others.length) lines.push(`Vendors that were detected: ${others.slice(0, 6).join(", ")}`);
      return lines;
    },
  },

  {
    id: "NO_CTA_ABOVE_FOLD",
    // A form whose fields sit in the first viewport IS an above-the-fold
    // conversion path, even when its submit button falls just below the fold:
    // the visitor can start converting without scrolling.
    severity: ({ audit }) => (audit.form_above_fold ? "low" : "high"),
    category: "cta",
    title: "No call to action appears within the first viewport",
    description: ({ audit, a }) =>
      audit.form_above_fold
        ? `The conversion form is inside the first viewport, but its submit control sits below the ${a.page.dimensions.fold_height}px fold.`
        : "Every CTA found on the page sits below the fold height measured at capture, so a visitor must scroll before any action is offered.",
    recommendation: ({ audit }) =>
      audit.form_above_fold
        ? "Optional: tighten the form so its submit button also lands inside the first viewport."
        : "Repeat the primary action inside the hero so it is visible without scrolling.",
    impact: ({ audit }) =>
      audit.form_above_fold
        ? `The ${audit.label}'s conversion path does start above the fold, so this is a refinement rather than a blocker.`
        : `Nothing on ${withArticle(audit.label)} invites action until the visitor scrolls.`,
    rationale: ({ audit }) =>
      audit.form_above_fold ? "Downgraded from high: the form itself is above the fold." : undefined,
    evidence: ({ a, facts, audit }) => {
      if (!a.ctas.length || facts.aboveFoldCtas.length > 0) return [];
      const lines = [
        `${a.ctas.length} CTA(s) detected, none within the ${a.page.dimensions.fold_height}px fold`,
      ];
      const first = [...a.ctas].sort((left, right) => left.position.y - right.position.y)[0];
      if (first) {
        const owner = first.form_index !== null ? " (the form's own submit control)" : "";
        lines.push(`Highest CTA ${quote(first.text)}${owner} sits at y=${first.position.y}px`);
      }
      if (audit.form_above_fold) {
        const form = a.forms.find((entry) => entry.location.above_fold && entry.location.visible);
        if (form) {
          lines.push(`A ${form.field_count}-field form starts at y=${form.location.y}px, inside the fold`);
        }
      }
      return lines;
    },
  },

  {
    id: "NO_FORM_OR_CONVERSION_PATH",
    severity: "high",
    category: "conversion",
    title: "The page's calls to action lead nowhere that captures a conversion",
    description:
      "CTAs are present, but every one of them stays on the page or has no destination at all, and the page carries no form and no checkout signal, so no observable place exists for a visitor to convert.",
    recommendation:
      "Give the CTAs a destination that captures the conversion: an on-page form, an embedded scheduler, or a checkout.",
    evidence: ({ a, facts }) => {
      if (!deadEndConversionPath(a, facts)) return [];
      const lines = [
        `${a.ctas.length} CTA(s) detected, 0 forms on the page and no checkout signal`,
        `Every CTA destination stays on the page or is absent: ${facts.destinationHistogram}`,
      ];
      for (const cta of a.ctas.slice(0, 4)) {
        const href = cta.href === null ? "no href attribute" : `href="${trim(cta.href, 80)}"`;
        lines.push(`CTA ${quote(cta.text)} has ${href} (destination kind: ${cta.destination.kind})`);
      }
      return lines;
    },
  },

  {
    id: "NO_VISIBLE_SOCIAL_PROOF",
    // Absence of proof is an observation. Whether it is a defect depends
    // entirely on what the page is trying to do.
    severity: ({ audit }) =>
      temperByConfidence(severityForMissing(audit.expects.proof), audit.classification_confidence),
    category: "trust",
    title: "No visible social proof was detected",
    description: ({ audit }) =>
      `No testimonials, client logos, ratings or numeric proof claims were detected in the rendered page. On ${withArticle(audit.label)} this is ${
        audit.expects.proof === "expected" ? "usually a real gap" : "a conversion opportunity rather than a defect"
      }.`,
    recommendation: ({ audit }) =>
      audit.expects.proof === "expected"
        ? "Add specific, attributed proof near the primary action — a named testimonial or a concrete result."
        : `Consider adding one piece of attributed proof near the ${audit.conversion_path === "form" ? "form" : "primary action"}; absence is not itself a fault on ${withArticle(audit.label)}.`,
    impact: ({ audit }) => {
      if (audit.expects.proof === "expected") {
        return `A ${audit.label} asks for a decision that usually needs evidence, so missing proof is likely to cost conversions.`;
      }
      if (audit.expects.proof === "irrelevant") {
        return `Proof is not typically expected on ${withArticle(audit.label)}.`;
      }
      return `On ${withArticle(audit.label)} the visitor is committing very little, so missing proof is an opportunity rather than a blocker.`;
    },
    confidence: () => 0.6,
    rationale: ({ audit }) =>
      `Severity set from funnel context: proof is "${audit.expects.proof}" on ${withArticle(audit.label)}.`,
    evidence: ({ a }) => {
      const proof = a.social_proof;
      const empty =
        proof.testimonial_count === 0 &&
        proof.client_logos.length === 0 &&
        proof.ratings.length === 0 &&
        proof.numeric_claims.length === 0 &&
        proof.media_mentions.length === 0 &&
        proof.authority_indicators.length === 0 &&
        proof.trust_badges.length === 0 &&
        proof.case_studies.length === 0;
      if (!empty) return [];
      return [
        `0 testimonials, 0 client logos, 0 ratings and 0 numeric claims across ${a.copy.word_count} words of visible copy`,
        `0 media mentions, 0 authority indicators, 0 trust badges and 0 case studies were detected`,
      ];
    },
  },

  {
    id: "COMPETING_PRIMARY_ACTIONS",
    severity: "medium",
    category: "cta",
    title: "Several different actions compete inside the first viewport",
    description:
      "The CTAs visible without scrolling point at four or more distinct destinations, so the first screen asks the visitor to choose between actions rather than take one.",
    recommendation:
      "Keep one action above the fold and demote the rest below it or into the navigation.",
    evidence: ({ facts }) => {
      const byDestination = new Map<string, CtaEntry>();
      for (const cta of facts.aboveFoldCtas) {
        // Only a URL or an anchor is an observed destination. Grouping
        // script-driven or href-less CTAs by their kind would invent
        // distinctions between destinations we never saw.
        const key = destinationKey(cta);
        if (key === null) continue;
        if (!byDestination.has(key)) byDestination.set(key, cta);
      }
      if (byDestination.size < 4) return [];
      const lines = [
        `${facts.aboveFoldCtas.length} above-the-fold CTA(s) point at ${byDestination.size} distinct observed destinations`,
      ];
      for (const [key, cta] of [...byDestination].slice(0, 6)) {
        lines.push(`${quote(cta.text)} -> ${trim(key, 100)}`);
      }
      return lines;
    },
  },

  {
    id: "CONSOLE_ERRORS",
    // Third-party security widgets log noisily by design. Only first-party
    // errors, on a page that did not render, are a conversion problem.
    severity: ({ a, audit }) => {
      const firstParty = a.technical.console_errors.filter((error) => error.party === "first_party");
      if (!firstParty.length) return "informational";
      if (!audit.page_rendered) return "high";
      return audit.conversion_visible_above_fold || audit.has_form ? "low" : "medium";
    },
    category: "technical",
    title: "The browser console reported errors while rendering",
    description: ({ a }) => {
      const errors = a.technical.console_errors;
      const firstParty = errors.filter((error) => error.party === "first_party").length;
      if (!firstParty) {
        return "Console errors were recorded, none of them raised by the site's own code.";
      }
      return "Error-level console output was recorded during the single page load. Scripted behaviour on the page may not have completed.";
    },
    recommendation: ({ a }) =>
      a.technical.console_errors.some((error) => error.party === "first_party")
        ? "Reproduce the load with the console open and resolve the first-party errors listed below."
        : "No action required unless the third-party widget involved is part of your conversion path: the page, its copy and its conversion path all rendered.",
    impact: ({ a, audit }) => {
      const firstParty = a.technical.console_errors.filter((error) => error.party === "first_party");
      if (!firstParty.length) {
        return audit.page_rendered
          ? "No conversion impact observed: the page, its copy and its conversion path all rendered."
          : "The page did not fully render, so these are worth checking even though they are third-party.";
      }
      return `First-party script errors on ${withArticle(audit.label)} can stop the conversion path from working.`;
    },
    confidence: ({ a }) =>
      a.technical.console_errors.some((error) => error.party === "first_party") ? 0.7 : 0.9,
    rationale: ({ a }) => {
      const parties = new Set(a.technical.console_errors.map((error) => error.party));
      if (parties.has("first_party")) return undefined;
      const named = [...parties].filter((party) => party !== "unknown").join(", ") || "third-party";
      return `Informational: every error came from ${named} sources and the page rendered.`;
    },
    evidence: ({ a }) => {
      const errors = a.technical.console_errors;
      if (!errors.length) return [];
      const counts = new Map<string, number>();
      for (const error of errors) counts.set(error.party, (counts.get(error.party) ?? 0) + 1);
      const breakdown = [...counts.entries()].map(([party, count]) => `${count} ${party}`).join(", ");
      const lines = [`${errors.length} console error(s) recorded during page load (${breakdown})`];
      // Lead with first-party errors: they are the ones that matter.
      const ordered = [...errors].sort(
        (left, right) => Number(right.party === "first_party") - Number(left.party === "first_party"),
      );
      for (const error of ordered.slice(0, 3)) {
        const vendor = error.vendor ? ` [${error.vendor}]` : "";
        const source = error.source ? ` (source: ${trim(error.source, 100)})` : "";
        lines.push(`${error.party}${vendor}: ${quote(error.text)}${source}`);
      }
      return lines;
    },
  },

  {
    id: "EXCESSIVE_NAVIGATION",
    severity: "medium",
    category: "navigation",
    title: "A full navigation menu sits on a single-goal page",
    description:
      "The page was classified as a single-action funnel step, yet it carries a navigation menu with seven or more items, each of which is a way off the page.",
    recommendation:
      "Reduce the header to a logo and, if required, legal links, so the page keeps a single exit.",
    evidence: ({ a }) => {
      const funnel = a.funnel.funnel_type;
      if (funnel.status !== "detected" || !FOCUSED_FUNNELS.has(funnel.value)) return [];
      if (a.navigation.nav_item_count < 7) return [];
      const labels = a.navigation.nav_items
        .map((item) => item.text.trim())
        .filter(Boolean)
        .slice(0, 8);
      const lines = [
        `${a.navigation.nav_item_count} navigation items on a page whose funnel type was determined to be "${funnel.value}"`,
      ];
      if (labels.length) lines.push(`Navigation items: ${labels.map((label) => quote(label)).join(", ")}`);
      lines.push(`${a.navigation.exit_links_above_fold} exit link(s) sit above the fold`);
      return lines;
    },
  },

  {
    id: "FAILED_REQUESTS",
    // Same reasoning as CONSOLE_ERRORS: a Turnstile probe that retries is not
    // the funnel failing. Only first-party resources can break this page.
    severity: ({ a, audit }) => {
      const firstParty = a.technical.failed_requests.filter((request) => request.party === "first_party");
      if (!firstParty.length) return "informational";
      if (!audit.page_rendered) return "high";
      return "low";
    },
    category: "technical",
    title: "Requests failed while the page loaded",
    description: ({ a }) => {
      const firstParty = a.technical.failed_requests.filter((request) => request.party === "first_party").length;
      return firstParty
        ? "Resources served by this site failed to load during the single page load."
        : "Requests failed during the page load, none of them to this site's own domain.";
    },
    recommendation: ({ a }) =>
      a.technical.failed_requests.some((request) => request.party === "first_party")
        ? "Check the first-party resources listed below: a missing script or stylesheet can break the conversion path."
        : "No action required unless the third-party service listed is part of your conversion path.",
    impact: ({ a, audit }) => {
      const firstParty = a.technical.failed_requests.filter((request) => request.party === "first_party");
      if (!firstParty.length) {
        return audit.page_rendered
          ? "No conversion impact observed: the page and its conversion path rendered despite these."
          : "The page did not fully render; these failures may be involved.";
      }
      return `A failed first-party resource on ${withArticle(audit.label)} can break the conversion path.`;
    },
    rationale: ({ a }) => {
      const parties = new Set(a.technical.failed_requests.map((request) => request.party));
      if (parties.has("first_party")) return undefined;
      const named = [...parties].filter((party) => party !== "unknown").join(", ") || "third-party";
      return `Informational: every failure was ${named} and the page rendered.`;
    },
    evidence: ({ a }) => {
      const failures = a.technical.failed_requests;
      if (!failures.length) return [];
      const counts = new Map<string, number>();
      for (const failure of failures) counts.set(failure.party, (counts.get(failure.party) ?? 0) + 1);
      const breakdown = [...counts.entries()].map(([party, count]) => `${count} ${party}`).join(", ");
      const lines = [`${failures.length} request(s) failed during page load (${breakdown})`];
      const ordered = [...failures].sort(
        (left, right) => Number(right.party === "first_party") - Number(left.party === "first_party"),
      );
      for (const failure of ordered.slice(0, 3)) {
        const vendor = failure.vendor ? ` [${failure.vendor}]` : "";
        lines.push(`${failure.party}${vendor}: ${trim(failure.url, 110)} — ${failure.reason}`);
      }
      return lines;
    },
  },

  {
    id: "HORIZONTAL_OVERFLOW",
    severity: "medium",
    category: "technical",
    title: "The page scrolls sideways",
    description:
      "The document is wider than the viewport it was rendered in, which produces a horizontal scrollbar and cut-off content.",
    recommendation:
      "Find the element wider than its container and constrain it with a max-width or overflow rule.",
    evidence: ({ a }) => {
      if (a.technical.horizontal_overflow !== true) return [];
      const dims = a.page.dimensions;
      // The cited measurement has to show the overflow itself, not just the
      // flag that was derived from it.
      if (dims.scroll_width <= dims.viewport_width) return [];
      const lines = [
        `Document scroll width ${dims.scroll_width}px exceeds the ${dims.viewport_width}px viewport`,
      ];
      if (a.technical.mobile.tested && a.technical.mobile.horizontal_overflow === true) {
        lines.push(
          `Horizontal overflow also observed at a ${a.technical.mobile.viewport_width ?? "mobile"}px viewport`,
        );
      }
      return lines;
    },
  },

  {
    id: "MISSING_H1",
    severity: "medium",
    category: "seo",
    title: "The page has no H1",
    description:
      "No <h1> element is present in the rendered document, so the page states no top-level heading to search engines or assistive technology.",
    recommendation: "Mark the main headline up as the single <h1>.",
    evidence: ({ a }) => {
      if (a.seo.h1.visible_count !== 0) return [];
      const lines = [`0 <h1> elements in the rendered document at ${trim(a.page.final_url, 100)}`];
      const first = a.headings.find((heading) => heading.visible);
      lines.push(
        first
          ? `${a.headings.length} heading(s) detected; the first visible one is h${first.level} ${quote(first.text)}`
          : "No headings of any level were detected",
      );
      return lines;
    },
  },

  {
    id: "MISSING_TITLE",
    severity: "medium",
    category: "seo",
    title: "The page has no title",
    description:
      "The rendered document has no non-empty <title>, so browser tabs, search results and shared links have no name to show.",
    recommendation: "Add a <title> that names the offer and the brand.",
    evidence: ({ a }) => {
      const title = a.seo.title;
      if (title.present && (title.text ?? "").trim().length > 0) return [];
      const lines = [`<title> is absent or empty on ${trim(a.page.final_url, 120)}`];
      if (a.seo.h1.texts.length) lines.push(`H1 on the page: ${quote(a.seo.h1.texts[0] ?? "")}`);
      return lines;
    },
  },

  {
    id: "MISSING_VIEWPORT_META",
    severity: "medium",
    category: "technical",
    title: "The page declares no viewport meta tag",
    description:
      "No <meta name=\"viewport\"> was found in the rendered head, so mobile browsers fall back to a desktop-width viewport and scale the page down.",
    recommendation:
      "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to the document head.",
    evidence: ({ a, capture }) => {
      const declared = (a.technical.viewport_meta ?? a.seo.viewport_meta ?? "").trim();
      if (declared) return [];
      // Only report when the snapshot positively confirms the tag is absent.
      if (capture.snapshot.has_viewport_meta !== false) return [];
      const lines = [`No <meta name="viewport"> in the rendered head of ${trim(a.page.final_url, 120)}`];
      if (a.technical.mobile.tested) {
        lines.push(
          `Mobile pass at ${a.technical.mobile.viewport_width ?? "unknown"}px reported viewport meta present: ${a.technical.mobile.viewport_meta_present}`,
        );
      }
      return lines;
    },
  },

  {
    id: "NO_ADVERTISING_PIXEL_DETECTED",
    severity: "medium",
    category: "tracking",
    title: "No advertising pixel was observable in the rendered page",
    description:
      "None of the scripts, globals or requests present after render matched a known advertising pixel. A pixel loaded later, through a tag manager, or server-side would not be visible here.",
    recommendation:
      "If this page receives paid traffic, confirm that the ad platform's pixel fires on this URL.",
    evidence: ({ a }) => {
      if (a.tracking.has_advertising_pixel) return [];
      const lines = [
        `No advertising pixel matched among ${a.tracking.script_count} script element(s) on the rendered page`,
      ];
      const hosts = a.tracking.third_party_script_hosts;
      lines.push(
        hosts.length
          ? `Third-party script hosts observed: ${hosts.slice(0, 6).join(", ")}`
          : "No third-party script hosts were observed",
      );
      if (a.tracking.has_tag_manager) {
        lines.push("A tag manager was detected; pixels it injects are not visible in the rendered markup");
      }
      return lines;
    },
  },

  {
    id: "NO_PRICE_AND_NO_LEAD_CAPTURE",
    severity: "medium",
    category: "conversion",
    title: "The page neither states a price nor captures a lead",
    description:
      "No price was detected, no form is present, and no CTA points at a scheduler, form embed or submit control, so the page ends without asking for money or contact details.",
    recommendation:
      "Decide which the page is for and add the matching element: a stated price and checkout, or a form or booking step.",
    evidence: ({ a, facts }) => {
      if (a.pricing.detected || a.pricing.items.length > 0) return [];
      if (a.forms.length > 0) return [];
      if (facts.conversionCtas.length > 0) return [];
      // A checkout is where the money is asked for even when no price is
      // rendered; the sibling conversion rule already honours these signals.
      if (facts.checkoutSignals.length > 0) return [];
      // The higher-severity conversion-path rule reports this same observation.
      if (deadEndConversionPath(a, facts)) return [];
      const lines = [
        `0 price points and 0 forms detected across ${a.copy.word_count} words of visible copy`,
      ];
      lines.push(
        a.ctas.length
          ? `${a.ctas.length} CTA(s) detected; destinations observed: ${facts.destinationHistogram}`
          : "0 CTAs detected on the page",
      );
      return lines;
    },
  },

  {
    id: "OFFER_CLARITY_UNCLEAR",
    // Missing information is only a problem when this funnel type is expected
    // to state it. An application page legitimately never mentions price.
    severity: ({ a, audit }) => {
      const missing = relevantMissing(a, audit);
      if (!missing.length) return "informational";
      const expected = missing.filter((piece) => expectationFor(audit, piece) === "expected");
      return temperByConfidence(expected.length ? "medium" : "low", audit.classification_confidence);
    },
    category: "offer",
    title: "The offer could not be read clearly from the page",
    description: ({ a, audit }) => {
      const missing = relevantMissing(a, audit);
      return missing.length
        ? `On ${withArticle(audit.label)} the page does not state: ${missing.join(", ")}.`
        : `Everything ${withArticle(audit.label)} is expected to state was found; only elements this funnel type does not need are absent.`;
    },
    recommendation: ({ a, audit }) => {
      const missing = relevantMissing(a, audit);
      return missing.length
        ? `State ${missing.join(" and ")} in the visible copy so a first-time visitor can tell what is on offer.`
        : "No change needed: the missing elements are not expected on this funnel type.";
    },
    impact: ({ a, audit }) => {
      const missing = relevantMissing(a, audit);
      if (!missing.length) return `Nothing ${withArticle(audit.label)} depends on is missing.`;
      return `A visitor on ${withArticle(audit.label)} cannot establish ${missing.join(" or ")} before being asked to ${goalPhrase(audit)}.`;
    },
    confidence: () => 0.55,
    rationale: ({ a, audit }) => {
      const ignored = ignoredMissing(a, audit);
      return ignored.length
        ? `Ignored as irrelevant on ${withArticle(audit.label)}: ${ignored.join(", ")}.`
        : undefined;
    },
    evidence: ({ a, audit }) => {
      const clarity = a.offer.clarity;
      if (clarity.status !== "detected" || clarity.value.clarity !== "unclear") return [];
      // Only the pieces this funnel type is expected to state can be a finding.
      const relevant = relevantMissing(a, audit);
      if (!relevant.length) return [];
      const lines = [`Not stated, and expected on ${withArticle(audit.label)}: ${relevant.join(", ")}`];
      const ignored = ignoredMissing(a, audit);
      if (ignored.length) lines.push(`Also absent, but not expected here: ${ignored.join(", ")}`);
      lines.push(...clarity.evidence.slice(0, 3).map((line) => trim(line)));
      return lines;
    },
  },

  {
    id: "THIN_COPY",
    severity: "medium",
    category: "copy",
    title: "The page carries very little copy",
    description:
      "Fewer than 100 words and fewer than 600 characters of visible text were extracted from the rendered page.",
    recommendation:
      "Add the copy a visitor needs to act: who it is for, what they get, and what happens after the CTA.",
    evidence: ({ a }) => {
      // Word count splits on whitespace, so a page written in Chinese, Japanese
      // or Thai reads as a handful of words however much text it carries. The
      // character count is what makes the page actually thin.
      if (a.copy.word_count >= 100 || a.copy.character_count >= 600) return [];
      // A sales-letter video carries the message instead of the copy, so a
      // short page around one is a format, not a defect.
      if (a.vsl.determination.status === "detected") return [];
      const lines = [
        `${a.copy.word_count} words (${a.copy.character_count} characters) of visible copy across ${a.copy.paragraph_count} paragraph(s)`,
      ];
      const sample = a.page.visible_text.text.trim();
      if (sample) lines.push(`Visible copy begins: ${quote(sample)}`);
      if (a.videos.length) {
        lines.push(
          `${a.videos.length} video(s) are embedded, so some of the message may be spoken rather than written`,
        );
      }
      return lines;
    },
  },

  {
    id: "BROKEN_HEADING_HIERARCHY",
    // Reasons about the headings a visitor can actually see: a hidden template
    // or legal heading must not create a structural finding.
    severity: "informational",
    category: "seo",
    title: "Visible heading levels skip a level",
    description:
      "The visible heading outline jumps a level (for example h1 straight to h3). This affects document structure for assistive technology and crawlers, not the conversion path.",
    recommendation:
      "Use heading levels in order for the visible outline, or restyle rather than re-level where the jump is purely visual.",
    evidence: ({ a }) => {
      const structure = a.seo.heading_structure;
      const skipped = structure.visible_skipped_levels;
      if (!skipped.length) return [];
      const lines = [
        `Visible heading levels skipped: ${skipped.map((level) => `h${level}`).join(", ")}`,
        `Visible heading order: ${structure.visible_order.map((level) => `h${level}`).join(" > ")}`,
      ];
      if (structure.dom_heading_count !== structure.visible_heading_count) {
        lines.push(
          `${structure.dom_heading_count} headings in the DOM, ${structure.visible_heading_count} visible (hidden ones ignored)`,
        );
      }
      return lines;
    },
  },

  {
    id: "IMAGES_MISSING_ALT",
    severity: "low",
    category: "accessibility",
    title: "Visible images carry no alt text",
    description:
      "Five or more images that render on the page expose no alt text, so screen readers announce nothing for them.",
    recommendation:
      "Describe each meaningful image in its alt attribute; leave alt empty only for purely decorative images.",
    evidence: ({ facts }) => {
      const missing = facts.visibleImagesWithoutAlt;
      if (missing.length < 5) return [];
      const lines = [
        `${missing.length} of ${facts.visibleImages.length} visible images carry no alt text`,
      ];
      for (const image of missing.slice(0, 3)) {
        lines.push(`Image without alt text: ${trim(image.src ?? "no src attribute", 120)}`);
      }
      return lines;
    },
  },

  {
    id: "MISSING_CANONICAL",
    severity: "low",
    category: "seo",
    title: "The page declares no canonical URL",
    description:
      "No <link rel=\"canonical\"> was found in the rendered head, so duplicate URLs for this page have nothing pointing them at the original.",
    recommendation: "Add a self-referential canonical link to the document head.",
    evidence: ({ a }) => {
      if (a.seo.canonical.present) return [];
      const lines = [`No <link rel="canonical"> in the rendered head of ${trim(a.page.final_url, 120)}`];
      if (a.technical.redirected) {
        lines.push(
          `The request redirected ${a.technical.redirect_count} time(s) from ${trim(a.funnel.requested_url, 100)}`,
        );
      }
      return lines;
    },
  },

  {
    id: "MISSING_META_DESCRIPTION",
    severity: "low",
    category: "seo",
    title: "The page has no meta description",
    description:
      "No <meta name=\"description\"> was found, so search engines and social previews compose their own snippet from the page body.",
    recommendation: "Add a meta description that states the offer in one sentence.",
    evidence: ({ a }) => {
      if (a.seo.meta_description.present) return [];
      const lines = [`No <meta name="description"> in the rendered head of ${trim(a.page.final_url, 120)}`];
      if (a.seo.title.text) lines.push(`Page title: ${quote(a.seo.title.text)}`);
      return lines;
    },
  },

  {
    id: "MULTIPLE_H1",
    severity: "low",
    category: "seo",
    title: "The page has more than one H1",
    description:
      "Several visible <h1> elements are present, so the document declares more than one top-level heading.",
    recommendation: "Keep one <h1> for the main headline and demote the rest.",
    evidence: ({ a }) => {
      // Hidden template and legal blocks routinely carry their own h1. Only the
      // headings a visitor can see form the document's real outline.
      if (a.seo.h1.visible_count < 2) return [];
      const lines = [`${a.seo.h1.visible_count} visible <h1> elements in the rendered document`];
      if (a.seo.h1.count !== a.seo.h1.visible_count) {
        lines.push(`${a.seo.h1.count} exist in the DOM; hidden ones were ignored`);
      }
      for (const text of a.seo.h1.visible_texts.slice(0, 5)) lines.push(`H1: ${quote(text)}`);
      return lines;
    },
  },

  {
    id: "NO_GUARANTEE_OR_RISK_REVERSAL",
    severity: "low",
    category: "offer",
    title: "A price is shown with no guarantee beside it",
    description:
      "The page states a price, but no guarantee, refund promise, trial or other risk-reversal statement was found in the visible copy.",
    recommendation:
      "State the terms that reduce the buyer's risk, or say plainly that the purchase is final.",
    evidence: ({ a }) => {
      const pricedItems = a.pricing.items;
      if (!a.pricing.detected || !pricedItems.length) return [];
      if (a.guarantees.detected || a.guarantees.risk_reversal_present) return [];
      if (a.offer.guarantee_present || a.offer.risk_reversal.status === "detected") return [];
      const lines = [
        `Price shown on the page: ${quote(pricedItems[0]?.text ?? "")}`,
      ];
      if (pricedItems.length > 1) {
        lines.push(`${pricedItems.length} price points detected in total`);
      }
      lines.push(
        `0 guarantee statements detected across ${a.copy.word_count} words of visible copy`,
      );
      return lines;
    },
  },

  {
    id: "WEAK_CTA_HIERARCHY",
    severity: "low",
    category: "cta",
    title: "The calls to action use inconsistent labels",
    description:
      "The visible CTAs use enough different wordings that no single action reads as the page's main one.",
    recommendation:
      "Use one label for the primary action wherever it repeats, and word secondary actions differently on purpose.",
    evidence: ({ a }) => {
      const consistency = a.summary.ctas.consistency;
      if (consistency.status !== "detected" || consistency.value.consistent !== false) return [];
      return consistency.evidence.slice(0, 6).map((line) => trim(line));
    },
  },
];

/* -------------------------------- helpers -------------------------------- */

function deriveFacts(input: IssueInput): IssueFacts {
  const { capture, analysis } = input;
  const ctas = analysis.ctas;

  const aboveFoldCtas = ctas.filter((cta) => cta.above_fold);
  const conversionCtas = ctas.filter((cta) => CONVERSION_DESTINATIONS.has(cta.destination.kind));

  const visibleImages = capture.snapshot.images.filter((image) => image.visible);
  const visibleImagesWithoutAlt = visibleImages.filter((image) => !(image.alt ?? "").trim());

  return {
    aboveFoldCtas,
    conversionCtas,
    checkoutSignals: checkoutSignals(analysis),
    destinationHistogram: destinationHistogram(ctas),
    brokenImages: brokenImages(input),
    visibleImages,
    visibleImagesWithoutAlt,
  };
}

/** The smallest box a broken image can occupy and still be something a visitor sees. */
const MIN_VISIBLE_IMAGE_PX = 8;

/**
 * naturalWidth === 0 is also true of inline SVG sprites, of lazy-loading
 * placeholders and of 1x1 tracking pixels, none of which is a broken image. Only
 * a raster source that the layout gave a real box to survives, and the box is
 * taken from the rendered image record so it can be cited.
 */
function brokenImages(input: IssueInput): BrokenImage[] {
  const rendered = new Map<string, ImageRecord>();
  for (const image of input.capture.snapshot.images) {
    if (image.src && !rendered.has(image.src)) rendered.set(image.src, image);
  }

  const results: BrokenImage[] = [];
  for (const broken of input.analysis.technical.broken_images) {
    const src = broken.src;
    if (!src) continue;
    if (/^data:/i.test(src)) continue;
    if (/\.svg([?#].*)?$/i.test(src)) continue;
    const box = rendered.get(src);
    if (!box) continue;
    if (box.width < MIN_VISIBLE_IMAGE_PX || box.height < MIN_VISIBLE_IMAGE_PX) continue;
    results.push({ src, alt: broken.alt, width: box.width, height: box.height });
  }
  return results;
}

/**
 * Controls that ask for an action regardless of their label. An anchor is
 * excluded: a page of links is not a page with a button, and every anchor was
 * already offered to the CTA detector.
 */
function visibleActionControls(capture: CaptureResult): CaptureResult["snapshot"]["buttons"] {
  return capture.snapshot.buttons.filter((control) => control.visible && control.tag !== "a");
}

/** Destination kinds that never leave the page, so they capture nothing on their own. */
const DEAD_END_DESTINATIONS = new Set(["anchor", "javascript", "none", "unknown"]);

/**
 * True only when every CTA on the page is a dead end. A CTA that navigates
 * internally or externally may well lead to a form on the next step; this API
 * loads one page and never follows it, so that path is unobserved, not absent.
 */
function deadEndConversionPath(a: Analysis, facts: IssueFacts): boolean {
  if (!a.ctas.length) return false;
  if (a.forms.length > 0) return false;
  if (facts.conversionCtas.length > 0) return false;
  if (facts.checkoutSignals.length > 0) return false;
  return a.ctas.every((cta) => DEAD_END_DESTINATIONS.has(cta.destination.kind));
}

/**
 * A "broken" probe result covers both the destination answering with an error
 * and our own request never arriving. A timeout, a refusal, a bot wall
 * (401/403) or a rate limit describes the probe, not the page, so only a status
 * that says the resource is gone or the server failed counts.
 */
function isBrokenDestination(destination: CtaEntry["destination"]): boolean {
  if (destination.resolves !== "broken") return false;
  // The link checker labels the probe outcome once it exposes one; where it
  // does, it is the authority on which of the two failed.
  const outcome = (destination as { outcome?: string }).outcome;
  if (typeof outcome === "string") return outcome === "broken";
  const status = destination.status;
  if (status === null) return false;
  return status === 404 || status === 410 || (status >= 500 && status < 600);
}

/** Destination kinds that are, on their own, somewhere a visitor can convert. */
const CONVERSION_DESTINATIONS = new Set([
  "scheduler",
  "form_embed",
  "form_submit",
  "mailto",
  "tel",
]);

/**
 * Observed reasons to believe a purchase can be completed. Used only to hold
 * issues back, so a generous match can only cause a missed issue, never a
 * false one.
 */
function checkoutSignals(a: Analysis): string[] {
  const signals: string[] = [];

  if (a.funnel.page_type_classification.page_type === "checkout") {
    signals.push("The page classifier read this page as a checkout");
  }
  if (a.funnel.funnel_type.status === "detected" && a.funnel.funnel_type.value === "checkout") {
    signals.push("The funnel type was determined to be a checkout");
  }

  for (const cta of a.ctas) {
    const url = cta.destination.url;
    if (!url) continue;
    if (CHECKOUT_HOSTS.test(cta.destination.host ?? "") || CHECKOUT_PATHS.test(url)) {
      signals.push(`CTA ${quote(cta.text)} points at ${trim(url, 100)}`);
      break;
    }
  }

  for (const form of a.forms) {
    if (form.fields.some((field) => field.purpose === "payment")) {
      signals.push(`A form on the page exposes a payment field (provider: ${form.provider})`);
      break;
    }
  }

  for (const frame of a.technical.iframes) {
    if (CHECKOUT_HOSTS.test(frame.src ?? "")) {
      signals.push(`An iframe loads a payment host: ${trim(frame.src ?? "", 100)}`);
      break;
    }
  }

  return signals;
}

function destinationHistogram(ctas: CtaEntry[]): string {
  const counts = new Map<string, number>();
  for (const cta of ctas) {
    counts.set(cta.destination.kind, (counts.get(cta.destination.kind) ?? 0) + 1);
  }
  const parts = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([kind, count]) => `${kind} x${count}`);
  return parts.length ? parts.join(", ") : "none";
}

/** The destination we actually observed, or null when there is none to compare. */
function destinationKey(cta: CtaEntry): string | null {
  if (cta.destination.url) return cta.destination.url;
  if (cta.destination.same_page_anchor) return `#${cta.destination.same_page_anchor}`;
  return null;
}

function trim(text: string, max = EVIDENCE_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function quote(text: string): string {
  return `"${trim(text)}"`;
}
