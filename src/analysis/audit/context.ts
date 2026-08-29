import type { PageType } from "../../types/index.js";
import type {
  ConversionGoal,
  FunnelType,
  IssueSeverity,
  LandingAnalysis,
} from "../landing_types.js";

type Analysis = Omit<LandingAnalysis, "observed_issues">;

/** How much a missing offer element matters on a given kind of funnel. */
export type Expectation = "expected" | "optional" | "irrelevant";

export interface AuditContext {
  funnel_type: FunnelType | "unknown";
  page_type: PageType;
  conversion_goal: ConversionGoal | "unknown";
  /** Confidence in the funnel read itself. Low confidence softens severity. */
  classification_confidence: number;
  fold_height: number;
  /** What a visitor is actually meant to do here. */
  conversion_path: "form" | "scheduler" | "checkout" | "external_form" | "link" | "none";
  has_form: boolean;
  form_above_fold: boolean;
  /** The conversion action is reachable in the first viewport. */
  conversion_visible_above_fold: boolean;
  page_rendered: boolean;
  /** What this funnel type is expected to state. Drives offer-clarity severity. */
  expects: {
    price: Expectation;
    proof: Expectation;
    audience: Expectation;
    benefits: Expectation;
    guarantee: Expectation;
  };
  /** One line naming the funnel, reused in issue wording. */
  label: string;
}

const DEFAULT_EXPECTATIONS: AuditContext["expects"] = {
  price: "optional",
  proof: "optional",
  audience: "optional",
  benefits: "optional",
  guarantee: "optional",
};

/**
 * What each funnel type is genuinely expected to put on the page. An
 * application page that never states a price is behaving correctly; a sales
 * page that never states one is missing something.
 */
const EXPECTATIONS: Partial<Record<FunnelType | "unknown", AuditContext["expects"]>> = {
  sales_page: { price: "expected", proof: "expected", audience: "expected", benefits: "expected", guarantee: "optional" },
  checkout: { price: "expected", proof: "optional", audience: "irrelevant", benefits: "optional", guarantee: "optional" },
  application: { price: "irrelevant", proof: "optional", audience: "expected", benefits: "optional", guarantee: "irrelevant" },
  booking: { price: "irrelevant", proof: "optional", audience: "expected", benefits: "optional", guarantee: "irrelevant" },
  optin: { price: "irrelevant", proof: "optional", audience: "optional", benefits: "optional", guarantee: "irrelevant" },
  lead_magnet: { price: "irrelevant", proof: "optional", audience: "optional", benefits: "optional", guarantee: "irrelevant" },
  webinar_registration: { price: "irrelevant", proof: "optional", audience: "optional", benefits: "expected", guarantee: "irrelevant" },
  vsl: { price: "optional", proof: "expected", audience: "expected", benefits: "expected", guarantee: "optional" },
};

const LABELS: Record<string, string> = {
  sales_page: "long-form sales page",
  checkout: "checkout page",
  application: "application funnel",
  booking: "booking funnel",
  optin: "opt-in page",
  lead_magnet: "lead-magnet page",
  webinar_registration: "webinar registration page",
  vsl: "video sales letter",
  unknown: "page",
};

/**
 * Everything the audit engine needs to judge an observation. Built once from
 * the extracted analysis; no rule re-derives this.
 */
export function buildAuditContext(a: Analysis): AuditContext {
  const funnelType = a.funnel.funnel_type.status === "detected" ? a.funnel.funnel_type.value : "unknown";
  const goal = a.funnel.primary_conversion_goal.status === "detected"
    ? a.funnel.primary_conversion_goal.value
    : "unknown";
  const confidence = a.funnel.funnel_type.status === "detected" ? a.funnel.funnel_type.confidence : 0;

  const foldHeight = a.page.dimensions.fold_height || a.page.dimensions.viewport_height || 0;
  const realForms = a.forms.filter((form) => form.integration !== "external_link");
  const hasForm = realForms.length > 0;
  const formAboveFold = realForms.some((form) => form.location.above_fold && form.location.visible);

  const schedulerCta = a.ctas.some((cta) => cta.destination.kind === "scheduler");
  const checkoutCta = a.ctas.some((cta) => /checkout|cart|payment|buy/i.test(cta.destination.url || ""));
  const externalForm = a.forms.some((form) => form.integration === "external_link");

  const conversionPath: AuditContext["conversion_path"] = hasForm
    ? "form"
    : schedulerCta
      ? "scheduler"
      : checkoutCta
        ? "checkout"
        : externalForm
          ? "external_form"
          : a.ctas.length
            ? "link"
            : "none";

  // A form whose fields are in the first viewport IS an above-the-fold
  // conversion path, even when its submit button sits just below the fold.
  const ctaAboveFold = a.ctas.some((cta) => cta.above_fold && cta.visible);
  const conversionVisible = ctaAboveFold || formAboveFold;

  return {
    funnel_type: funnelType,
    page_type: a.funnel.page_type_classification.page_type as PageType,
    conversion_goal: goal,
    classification_confidence: confidence,
    fold_height: foldHeight,
    conversion_path: conversionPath,
    has_form: hasForm,
    form_above_fold: formAboveFold,
    conversion_visible_above_fold: conversionVisible,
    page_rendered: pageRendered(a),
    expects: EXPECTATIONS[funnelType] ?? DEFAULT_EXPECTATIONS,
    label: LABELS[funnelType] ?? LABELS.unknown,
  };
}

/**
 * Did the page actually render for a visitor? Used to decide whether technical
 * errors had any user-facing consequence.
 */
function pageRendered(a: Analysis): boolean {
  const hasCopy = a.copy.word_count >= 30;
  const hasStructure = a.headings.some((heading) => heading.visible) || a.page.dom.paragraphs > 2;
  const ok = a.page.http_status === null || a.page.http_status < 400;
  return ok && hasCopy && hasStructure;
}

/** Severity for "an element this funnel type is expected to carry is absent". */
export function severityForMissing(expectation: Expectation): IssueSeverity {
  if (expectation === "expected") return "medium";
  if (expectation === "optional") return "low";
  return "informational";
}

/** "application funnel" -> "an application funnel". */
export function withArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}
