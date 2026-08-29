import { ANALYSIS_SCHEMA_VERSION } from "../../src/types/index.js";
import type {
  FormRecord,
  FunnelMetadata,
  PageRecord,
} from "../../src/types/index.js";

export function metadata(overrides: Partial<FunnelMetadata> = {}): FunnelMetadata {
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    run_id: "example-com_offer_2026-01-01_1200",
    funnel_id: "example-com_offer",
    funnel_url: "https://example.com/offer",
    funnel_host: "example.com",
    business_name: "Example Co",
    device: "desktop",
    mode: "manual",
    crawler_version: "test",
    captured_at: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

export function form(overrides: Partial<FormRecord> = {}): FormRecord {
  const fields = overrides.fields ?? [];
  return {
    type: "optin",
    selector: "#lead-form",
    action: "https://example.com/submit",
    method: "post",
    field_count: fields.length,
    fields,
    submit_text: "Get access",
    visible: true,
    position: "above_fold",
    multi_step: false,
    progress_indicator: null,
    estimated_completion_burden: "low (2 fields, 2 required)",
    friction: null,
    ...overrides,
    fields,
  };
}

export function pageRecord(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    url: "https://example.com/offer",
    canonical_url: null,
    page_type: "optin",
    funnel_stage: "Opt-in",
    classification_confidence: 0.8,
    classification_evidence: ["opt-in form detected"],
    title: "Free Audit | Example Co",
    meta_description: "Book a free audit call.",
    timestamp: "2026-01-01T12:00:05.000Z",
    headings: [
      { level: 1, text: "Get your free profit audit", visible: true, position: "above_fold", y: 120 },
    ],
    subheadings: [],
    paragraphs: [
      {
        text: "We map the leaks in your funnel and hand you the fixes on a 30 minute call.",
        visible: true,
        position: "above_fold",
        y: 240,
      },
    ],
    visible_text: "Get your free profit audit. We map the leaks in your funnel on a 30 minute call.",
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
      hero_heading: "Get your free profit audit",
      hero_subheading: null,
      primary_cta: null,
      primary_offer: null,
      first_visible_proof: null,
      first_visible_objection_handling: null,
      first_visible_price: null,
      first_visible_video: null,
      viewport_screenshot: null,
    },
    screenshots: [],
    technical_events: [],
    interaction_results: [],
    iframes: [],
    json_ld: [],
    technical_snapshot: {
      scripts: [],
      tracking_globals: [],
      broken_images: [],
      images_missing_alt: 0,
      language: "en",
      has_viewport_meta: true,
      body_overflow_x: false,
      viewport: { width: 1440, height: 900, scroll_width: 1440, scroll_height: 3200 },
    },
    ...overrides,
  };
}

export function cta(text: string, href: string | null, aboveFold = true) {
  return {
    text,
    type: "link" as const,
    href,
    visible: true,
    position: aboveFold ? ("above_fold" as const) : ("below_fold" as const),
    section: "hero",
    y: aboveFold ? 300 : 2400,
    supporting_copy: null,
    headline_above: null,
    stated_outcome: null,
  };
}
