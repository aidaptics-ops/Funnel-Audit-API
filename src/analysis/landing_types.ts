import type { PageScreenshot } from "../pipeline/screenshot.js";
import type {
  BenefitStackItem,
  FaqItem,
  FoldPosition,
  ObjectionRecord,
  PageType,
} from "../types/index.js";

export const ANALYSIS_SCHEMA_VERSION = "2.0";

/**
 * Anything that cannot be read straight off the page is reported as a
 * determination: either a detected value with the evidence behind it, or an
 * explicit "unknown". Never a guess.
 */
export type Determination<T> =
  | { status: "detected"; value: T; confidence: number; evidence: string[] }
  | { status: "unknown"; reason: string };

export function detected<T>(value: T, confidence: number, evidence: string[]): Determination<T> {
  return { status: "detected", value, confidence: Number(confidence.toFixed(2)), evidence };
}

export function unknown<T>(reason = "Insufficient evidence"): Determination<T> {
  return { status: "unknown", reason };
}

/**
 * "informational" is an observation with no demonstrated conversion impact —
 * a third-party console error on a page that rendered fine, for example.
 * "critical" requires evidence of an actual functional or conversion failure.
 */
export type IssueSeverity = "critical" | "high" | "medium" | "low" | "informational";

export type IssueCategory =
  | "conversion"
  | "cta"
  | "copy"
  | "trust"
  | "offer"
  | "form"
  | "navigation"
  | "tracking"
  | "seo"
  | "technical"
  | "accessibility"
  | "media";

export interface ObservedIssue {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  /** What was observed, stated as an observation. */
  description: string;
  /** Observed values that made this fire. Always non-empty. */
  evidence: string[];
  recommendation: string;
  /**
   * What the observation is likely to mean for THIS funnel type. Absent when
   * the finding is purely technical and funnel context does not change it.
   */
  impact?: string;
  /** How sure the engine is that this is a real problem, not just an absence. */
  confidence?: number;
  /** Why the severity landed where it did, when context moved it. */
  severity_rationale?: string;
}

export interface RedirectHop {
  url: string;
  status: number | null;
}

/* ------------------------------- funnel ------------------------------- */

export type FunnelType =
  | "vsl"
  | "optin"
  | "lead_magnet"
  | "webinar_registration"
  | "application"
  | "sales_page"
  | "booking"
  | "checkout"
  | "unknown";

export type ConversionGoal =
  | "book_a_call"
  | "opt_in"
  | "register_for_webinar"
  | "submit_application"
  | "purchase"
  | "download_lead_magnet"
  | "contact"
  | "watch_video"
  | "unknown";

/** Raw identity signals for the separate enrichment service. Never guessed. */
export interface BusinessIdentity {
  domain: string;
  root_domain: string;
  brand_name: string | null;
  brand_name_sources: string[];
  organization_names: string[];
  contact_emails: string[];
  contact_phones: string[];
  social_profiles: { platform: string; url: string }[];
  addresses: string[];
  copyright_holders: string[];
}

export interface FunnelSection {
  requested_url: string;
  final_url: string;
  domain: string;
  root_domain: string;
  redirected: boolean;
  redirect_chain: RedirectHop[];
  funnel_type: Determination<FunnelType>;
  page_type_classification: { page_type: PageType; confidence: number; evidence: string[] };
  brand_name: Determination<string>;
  primary_conversion_goal: Determination<ConversionGoal>;
  business_identity: BusinessIdentity;
}

/* -------------------------------- page -------------------------------- */

export interface PageSection {
  url: string;
  final_url: string;
  http_status: number | null;
  status_text: string | null;
  content_type: string | null;
  redirect_chain: RedirectHop[];
  title: string | null;
  meta_description: string | null;
  canonical: string | null;
  language: string | null;
  viewport_meta: string | null;
  charset: string | null;
  dimensions: {
    viewport_width: number;
    viewport_height: number;
    scroll_width: number;
    scroll_height: number;
    fold_height: number;
  };
  timing: { navigation_ms: number; render_wait_ms: number; total_ms: number };
  visible_text: { characters: number; words: number; truncated: boolean; text: string };
  sections: { tag: string; id: string | null; heading: string | null; y: number; height: number }[];
  dom: {
    headings: number;
    paragraphs: number;
    links: number;
    buttons: number;
    forms: number;
    images: number;
    iframes: number;
    scripts: number;
    videos: number;
  };
}

/* -------------------------------- hero -------------------------------- */

export interface HeroCta {
  text: string;
  type: CtaType;
  href: string | null;
  above_fold: boolean;
}

export interface HeroSection {
  fold_height: number;
  headline: string | null;
  subheadline: string | null;
  supporting_copy: string[];
  primary_cta: HeroCta | null;
  secondary_ctas: HeroCta[];
  cta_above_fold: boolean;
  offer: string | null;
  trust_elements: { kind: string; text: string }[];
  media: {
    kind: "video" | "image" | "none";
    provider: string | null;
    src: string | null;
    width: number | null;
    height: number | null;
  };
  value_proposition: Determination<{ clarity: "clear" | "unclear"; statement: string | null }>;
}

/* ------------------------------ headings ------------------------------ */

export interface HeadingEntry {
  level: number;
  text: string;
  length: number;
  visible: boolean;
  above_fold: boolean;
  y: number;
}

/* -------------------------------- copy -------------------------------- */

export interface CopySection {
  word_count: number;
  character_count: number;
  paragraph_count: number;
  language: string | null;
  measurements: {
    average_sentence_words: number | null;
    average_word_characters: number | null;
    all_caps_blocks: number;
    exclamation_marks: number;
    question_marks: number;
  };
  key_messages: string[];
  above_fold_copy: string[];
  repeated_messages: { text: string; occurrences: number }[];
  benefit_statements: BenefitStackItem[];
  objection_handling: ObjectionRecord[];
  faq: FaqItem[];
  inconsistencies: { kind: string; detail: string; evidence: string[] }[];
}

/* ------------------------------- videos ------------------------------- */

export interface VideoEntry {
  index: number;
  provider: string;
  src: string | null;
  video_id: string | null;
  embedded: boolean;
  visible: boolean;
  above_fold: boolean;
  position: FoldPosition;
  y: number | null;
  width: number | null;
  height: number | null;
  autoplay: boolean | null;
  muted: boolean | null;
  controls: boolean | null;
  duration_seconds: number | null;
  duration_text: string | null;
  thumbnail: string | null;
  play_button_visible: boolean;
  limitation: string | null;
}

export interface VslValue {
  video_index: number;
  provider: string;
}

export interface VslSection {
  determination: Determination<VslValue>;
  indicators: {
    video_above_fold: boolean;
    single_dominant_video: boolean;
    large_player: boolean;
    autoplay: boolean;
    minimal_navigation: boolean;
    watch_language: boolean;
    cta_below_video: boolean;
  };
}

/* --------------------------------- CTAs -------------------------------- */

export type CtaType = "button" | "link" | "form_submit" | "other";

export type CtaDestinationKind =
  | "internal"
  | "external"
  | "anchor"
  | "scheduler"
  | "form_embed"
  | "mailto"
  | "tel"
  | "javascript"
  | "none"
  | "form_submit"
  | "unknown";

export interface CtaEntry {
  index: number;
  text: string;
  type: CtaType;
  href: string | null;
  visible: boolean;
  above_fold: boolean;
  is_primary: boolean;
  /** Index into `forms` when this control submits a detected form. */
  form_index: number | null;
  /** True when this is the submit control of the page's conversion form. */
  is_form_submit: boolean;
  position: { x: number | null; y: number; fold: FoldPosition; section: string | null };
  destination: {
    kind: CtaDestinationKind;
    url: string | null;
    host: string | null;
    provider: string | null;
    same_page_anchor: string | null;
    resolves: "not_checked" | "ok" | "broken";
    status: number | null;
  };
  supporting_copy: string | null;
  stated_outcome: string | null;
}

/* -------------------------------- forms -------------------------------- */

export type FormIntegrationKind =
  | "native_html"
  | "iframe_embed"
  | "external_link"
  | "popup"
  | "orphan_fields"
  | "unknown";

export interface FormFieldEntry {
  label: string | null;
  name: string | null;
  type: string;
  purpose: string;
  required: boolean;
  option_count: number;
}

export interface FormEntry {
  index: number;
  provider: string;
  integration: FormIntegrationKind;
  location: {
    selector: string | null;
    y: number | null;
    above_fold: boolean;
    visible: boolean;
    in_modal: boolean;
  };
  iframe_url: string | null;
  action: string | null;
  method: string | null;
  cta_text: string | null;
  field_count: number;
  required_field_count: number;
  fields: FormFieldEntry[];
  fields_accessible: boolean;
  destination: { host: string | null; kind: string | null };
  /** Always false: this API never interacts with forms. */
  interacted: false;
  notes: string[];
}

/* ---------------------------- social proof ----------------------------- */

export interface TestimonialEntry {
  index: number;
  text: string;
  name: string | null;
  role: string | null;
  company: string | null;
  rating: number | null;
  result_claim: string | null;
  format: string;
  above_fold: boolean;
  y: number;
  source: string;
}

export interface SocialProofSection {
  testimonial_count: number;
  client_logos: { src: string | null; alt: string | null }[];
  media_mentions: { text: string; outlet: string | null }[];
  numeric_claims: { text: string; value: string }[];
  ratings: { value: string; scale: string | null; source_text: string }[];
  authority_indicators: { kind: string; text: string }[];
  trust_badges: { kind: string; text: string }[];
  case_studies: { text: string; position: FoldPosition }[];
  above_fold_proof_count: number;
}

/* -------------------------------- offer -------------------------------- */

export interface OfferSection {
  product: Determination<string>;
  audience: Determination<string>;
  mechanism: Determination<string>;
  benefits: string[];
  deliverables: string[];
  bonuses: { text: string; kind: string }[];
  price_points: string[];
  discounts: string[];
  guarantee_present: boolean;
  risk_reversal: Determination<string>;
  cta_relationship: {
    primary_cta_text: string | null;
    stated_outcome: string | null;
    supporting_copy: string | null;
  };
  clarity: Determination<{ clarity: "clear" | "unclear"; missing: string[] }>;
}

export interface GuaranteeEntry {
  text: string;
  kind: "money_back" | "results" | "satisfaction" | "free_trial" | "other";
  duration: string | null;
  position: FoldPosition;
}

export interface GuaranteesSection {
  detected: boolean;
  items: GuaranteeEntry[];
  risk_reversal_present: boolean;
}

export interface PriceEntry {
  text: string;
  amount: string | null;
  numeric_amount: number | null;
  currency: string | null;
  original_price: string | null;
  discount: string | null;
  recurring: boolean;
  payment_plan: string | null;
  position: FoldPosition;
  context: string | null;
}

export interface PricingSection {
  detected: boolean;
  currency: string | null;
  items: PriceEntry[];
  lowest: string | null;
  highest: string | null;
  payment_plans: string[];
  pricing_cta: string | null;
}

export interface UrgencySection {
  detected: boolean;
  evidence_quality: "explicit" | "language_only" | "none";
  countdown_timers: { text: string; value: string | null; selector: string | null; visible: boolean }[];
  deadlines: { text: string; date_text: string | null }[];
  scarcity_claims: { text: string; kind: string }[];
}

/* --------------------------- navigation, links -------------------------- */

export interface NavigationSection {
  has_navigation: boolean;
  nav_item_count: number;
  nav_items: { text: string; href: string | null; external: boolean }[];
  footer_item_count: number;
  footer_items: { text: string; href: string | null; external: boolean }[];
  exit_links_above_fold: number;
  logo_links_home: boolean;
}

export interface LinkCheckResult {
  url: string;
  status: number | null;
  ok: boolean;
  reason: string | null;
  /**
   * Why the probe ended the way it did. "blocked" (401/403/429) means the URL
   * exists but our unauthenticated probe was refused, and "unreachable" means
   * our probe failed - neither is evidence that the link is broken.
   */
  outcome?: "ok" | "broken" | "unreachable" | "blocked";
  /** The URL that actually produced `status`, when redirects were followed. */
  final_url?: string | null;
}

export interface LinksSection {
  total: number;
  unique: number;
  internal: number;
  external: number;
  anchors: number;
  mailto: string[];
  tel: string[];
  social: { platform: string; url: string }[];
  external_hosts: string[];
  checked: LinkCheckResult[];
  broken: LinkCheckResult[];
  check_summary: { checked: number; skipped: number; note: string };
}

/* ------------------------------- tracking ------------------------------- */

export interface TrackingVendor {
  vendor: string;
  category: "analytics" | "advertising_pixel" | "tag_manager" | "chat" | "heatmap" | "attribution" | "other";
  evidence: string[];
  ids: string[];
}

export interface TrackingSection {
  detected: TrackingVendor[];
  has_analytics: boolean;
  has_advertising_pixel: boolean;
  has_tag_manager: boolean;
  ids: Record<string, string[]>;
  third_party_script_hosts: string[];
  script_count: number;
  /** Phrased as observations about the rendered page, never about the business. */
  statements: string[];
}

/* --------------------------------- SEO ---------------------------------- */

export interface SeoSection {
  title: { text: string | null; length: number; present: boolean };
  meta_description: { text: string | null; length: number; present: boolean };
  canonical: { url: string | null; present: boolean; self_referential: boolean | null };
  robots: { content: string | null; indexable: boolean | null };
  h1: { count: number; texts: string[]; visible_count: number; visible_texts: string[] };
  heading_structure: {
    /** Every heading in the DOM, hidden ones included. */
    order: number[];
    skipped_levels: number[];
    starts_with_h1: boolean;
    /** Headings a visitor can actually see — what the audit reasons about. */
    visible_order: number[];
    visible_skipped_levels: number[];
    visible_starts_with_h1: boolean;
    dom_heading_count: number;
    visible_heading_count: number;
  };
  open_graph: Record<string, string | null>;
  twitter: Record<string, string | null>;
  structured_data: { types: string[]; count: number; parse_errors: number };
  images: { total: number; missing_alt: number; missing_alt_examples: string[] };
  language: string | null;
  viewport_meta: string | null;
}

/* ------------------------------ technical -------------------------------- */

/**
 * Where a console error or failed request came from. Third-party security
 * infrastructure failing is not the same as the funnel's own code failing.
 */
export type EventParty =
  | "first_party"
  | "third_party"
  | "security_infrastructure"
  | "analytics"
  | "browser"
  | "unknown";

export interface TechnicalEventClassification {
  party: EventParty;
  host: string | null;
  vendor: string | null;
}

export interface TechnicalSection {
  https: boolean;
  redirected: boolean;
  redirect_count: number;
  console_errors: (TechnicalEventClassification & { text: string; source: string | null })[];
  page_errors: string[];
  failed_requests: (TechnicalEventClassification & { url: string; status: number | null; reason: string })[];
  broken_images: { src: string | null; alt: string | null }[];
  iframes: { src: string | null; title: string | null; provider: string | null; visible: boolean }[];
  third_party_scripts: { host: string; count: number }[];
  script_count: number;
  viewport_meta: string | null;
  horizontal_overflow: boolean;
  render: { dom_content_loaded: boolean; network_idle: boolean; stability_events: string[] };
  resources: { requests: number; failed: number };
  mobile: {
    tested: boolean;
    viewport_meta_present: boolean;
    horizontal_overflow: boolean | null;
    viewport_width: number | null;
    note: string | null;
  };
}

/* ------------------------------- summary --------------------------------- */

export interface AnalysisSummary {
  ctas: {
    total: number;
    above_fold: number;
    primary_text: string | null;
    unique_destinations: number;
    consistency: Determination<{ consistent: boolean; distinct_labels: number }>;
  };
  forms: { total: number; providers: string[]; above_fold: number };
  videos: {
    /** Every player element found in the DOM, including hidden ones. */
    dom_count: number;
    /** Players that are actually rendered to a visitor. */
    visible_count: number;
    above_fold_count: number;
    /** Players whose provider and geometry could be read (VSL input). */
    analyzable_count: number;
    /** Alias of dom_count, kept so existing consumers keep working. */
    total: number;
    above_fold: number;
    providers: string[];
  };
  proof: { testimonials: number; logos: number; ratings: number };
  issues: { total: number; by_severity: Record<IssueSeverity, number> };
}

/* ------------------------------- analysis -------------------------------- */

export interface LandingAnalysis {
  /**
   * What the page looks like, in strips, when the caller asked for it.
   *
   * The rest of this object describes the markup. This describes the page, and
   * the two disagree more often than is comfortable — a scripted button with no
   * href reads as "no conversion path" here and as an obvious opt-in to anyone
   * looking at it.
   */
  screenshot?: PageScreenshot | null;
  schema_version: string;
  analyzed_at: string;
  duration_ms: number;
  funnel: FunnelSection;
  page: PageSection;
  hero: HeroSection;
  headings: HeadingEntry[];
  copy: CopySection;
  videos: VideoEntry[];
  vsl: VslSection;
  ctas: CtaEntry[];
  forms: FormEntry[];
  testimonials: TestimonialEntry[];
  social_proof: SocialProofSection;
  offer: OfferSection;
  guarantees: GuaranteesSection;
  pricing: PricingSection;
  urgency: UrgencySection;
  navigation: NavigationSection;
  links: LinksSection;
  tracking: TrackingSection;
  seo: SeoSection;
  technical: TechnicalSection;
  summary: AnalysisSummary;
  observed_issues: ObservedIssue[];
}

export interface AnalyzeResponse {
  status: "completed";
  job_id: string;
  url: string;
  analysis: LandingAnalysis;
}

export interface AnalyzeErrorResponse {
  status: "failed";
  job_id: string;
  url: string;
  error: { code: string; message: string };
}
