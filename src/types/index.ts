/**
 * Primitives produced by the DOM snapshot and the extraction detectors.
 * The shape returned by the API lives in `analysis/landing_types.ts`.
 */

export type DeviceProfileName = "desktop" | "mobile";

export type PageType =
  | "unknown"
  | "sales_page"
  | "optin"
  | "webinar_registration"
  | "vsl"
  | "application"
  | "booking"
  | "calendar"
  | "checkout"
  | "one_time_offer"
  | "confirmation"
  | "thank_you"
  | "training"
  | "community"
  | "login";

export type FoldPosition = "above_fold" | "below_fold" | "unknown";

export interface BrowserConfig {
  headless: boolean;
  device: DeviceProfileName;
  timeout_ms: number;
  navigation_timeout_ms: number;
  /** Empty string uses the bundled Chromium (the Docker default). */
  browser_channel?: string;
}

export interface DeviceProfile {
  name: DeviceProfileName;
  viewport: { width: number; height: number };
  userAgent: string;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export interface ClassificationResult {
  page_type: PageType;
  confidence: number;
  evidence: string[];
}

export interface HeadingRecord {
  level: number;
  text: string;
  visible: boolean;
  position: FoldPosition;
  y: number;
}

export interface TextBlock {
  text: string;
  visible: boolean;
  position: FoldPosition;
  y: number;
}

export interface ButtonRecord {
  text: string;
  tag: string;
  type: string | null;
  href: string | null;
  visible: boolean;
  position: FoldPosition;
  x: number | null;
  y: number;
  selector: string | null;
}

export interface LinkRecord {
  text: string;
  href: string | null;
  visible: boolean;
  position: FoldPosition;
  in_nav: boolean;
  in_footer: boolean;
  x: number | null;
  y: number;
}

export type FieldPurpose =
  | "email"
  | "first_name"
  | "last_name"
  | "full_name"
  | "phone"
  | "password"
  | "consent"
  | "search"
  | "payment"
  | "message"
  | "other";

export interface FormFieldRecord {
  name: string | null;
  id: string | null;
  label: string | null;
  type: string;
  placeholder: string | null;
  required: boolean;
  autocomplete: string | null;
  options: string[];
  purpose: FieldPurpose;
  checked: boolean | null;
  value_present: boolean;
  selector: string | null;
}

export type FormKind =
  | "optin"
  | "webinar_registration"
  | "application"
  | "checkout"
  | "login"
  | "booking"
  | "contact"
  | "search"
  | "unknown";

export interface ApplicationFriction {
  question_count: number;
  question_types: string[];
  free_response_count: number;
  multiple_choice_count: number;
  required_count: number;
  contact_fields_position: string | null;
  multi_step: boolean;
  progress_indicator: string | null;
  estimated_completion_burden: string | null;
}

export interface FormRecord {
  type: FormKind;
  selector: string | null;
  action: string | null;
  method: string;
  field_count: number;
  fields: FormFieldRecord[];
  submit_text: string | null;
  visible: boolean;
  position: FoldPosition;
  multi_step: boolean;
  progress_indicator: string | null;
  estimated_completion_burden: string | null;
  friction: ApplicationFriction | null;
}

export interface VideoRecord {
  provider: string;
  embedded: boolean;
  visible: boolean;
  autoplay: boolean | null;
  muted?: boolean | null;
  controls?: boolean | null;
  duration: string | number | null;
  src: string | null;
  position: FoldPosition;
  play_button_visible: boolean;
  thumbnail: string | null;
  width?: number;
  height?: number;
  y?: number;
  analysis_limitation: string | null;
}

export interface ImageRecord {
  src: string | null;
  alt: string | null;
  visible: boolean;
  position: FoldPosition;
  width: number;
  height: number;
}

export interface CtaRecord {
  text: string;
  type: "button" | "link" | "input" | "other";
  href: string | null;
  visible: boolean;
  position: FoldPosition;
  section: string | null;
  x: number | null;
  y: number;
  supporting_copy: string | null;
  headline_above: string | null;
  stated_outcome: string | null;
}

export interface PricingRecord {
  text: string;
  amount: string | null;
  currency: string | null;
  original_price: string | null;
  visible: boolean;
  position: FoldPosition;
  context: string | null;
}

export interface TestimonialRecord {
  text: string;
  name: string | null;
  claimed_result: string | null;
  format: string;
  visible: boolean;
  position: FoldPosition;
  section: string | null;
  y: number;
}

export interface FaqItem {
  question: string;
  answer: string | null;
  source: "schema" | "accordion" | "details" | "heading" | "text";
}

export interface FaqSection {
  heading: string | null;
  items: FaqItem[];
  position: FoldPosition;
}

export interface UrgencyRecord {
  text: string;
  kind: string;
  concrete_deadline_visible: boolean;
  timer_value: string | null;
  position: FoldPosition;
}

export interface SocialProofRecord {
  kind: string;
  text: string;
  position: FoldPosition;
  section: string | null;
}

export interface BenefitStackItem {
  heading: string | null;
  text: string;
  kind: string;
  position: FoldPosition;
}

export interface ObjectionRecord {
  topic: string;
  text: string;
  position: FoldPosition;
}

export interface BonusRecord {
  text: string;
  kind: "bonus" | "fast_action" | "attendance" | "registration";
  position: FoldPosition;
}

export interface OtoEvidence {
  detected: boolean;
  product_name: string | null;
  price: string | null;
  original_price: string | null;
  discount: string | null;
  cta_text: string | null;
  countdown: string | null;
  yes_no_options: string[];
  decline_link: string | null;
  evidence: string[];
}

export interface ProofPlacementRecord {
  kind: string;
  text: string;
  position: FoldPosition;
  relative_to: string[];
  y: number;
}

export interface CtaBenefitRelationship {
  cta_text: string;
  supporting_copy: string | null;
  headline_above: string | null;
  stated_outcome: string | null;
  instructions: string | null;
}

export interface AboveTheFoldData {
  hero_heading: string | null;
  hero_subheading: string | null;
  primary_cta: CtaRecord | null;
  primary_offer: string | null;
  first_visible_proof: string | null;
  first_visible_objection_handling: string | null;
  first_visible_price: string | null;
  first_visible_video: VideoRecord | null;
}

export interface TechnicalEvent {
  type: string;
  message: string;
  timestamp: string;
  url?: string;
}

export interface IframeRecord {
  src: string | null;
  title: string | null;
  visible: boolean;
  position: FoldPosition;
  inspectable: boolean;
  limitation: string | null;
  width?: number;
  height?: number;
}

export interface MetaRecord {
  description: string | null;
  canonical: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  og_type?: string | null;
  og_site_name?: string | null;
  og_url?: string | null;
  twitter_card?: string | null;
  twitter_title?: string | null;
  twitter_description?: string | null;
  twitter_image?: string | null;
  robots: string | null;
  author?: string | null;
  generator?: string | null;
  theme_color?: string | null;
}

export interface ScriptRecord {
  src: string | null;
  host: string | null;
  inline_snippet: string | null;
}

export interface PageTechnicalSnapshot {
  scripts: ScriptRecord[];
  tracking_globals: string[];
  broken_images: { src: string | null; alt: string | null; y: number }[];
  images_missing_alt: number;
  language: string | null;
  has_viewport_meta: boolean;
  body_overflow_x: boolean;
  viewport: { width: number; height: number; scroll_width: number; scroll_height: number };
}

export interface RawFormSnapshot {
  selector: string | null;
  action: string | null;
  method: string;
  visible: boolean;
  y: number;
  fields: FormFieldRecord[];
  submit_text: string | null;
  heading_near: string | null;
  in_modal?: boolean;
}

export interface DomSnapshot {
  url: string;
  title: string;
  meta: MetaRecord;
  json_ld: unknown[];
  viewport: { width: number; height: number; scroll_width: number; scroll_height: number };
  visible_text: string;
  headings: HeadingRecord[];
  paragraphs: TextBlock[];
  buttons: ButtonRecord[];
  links: LinkRecord[];
  forms: RawFormSnapshot[];
  videos: VideoRecord[];
  images: ImageRecord[];
  iframes: IframeRecord[];
  timers: { text: string; selector: string | null; y: number; visible: boolean }[];
  dialogs: { text: string; visible: boolean; role: string | null }[];
  body_overflow_x: boolean;
  sections?: { tag: string; id: string | null; heading: string | null; y: number; height: number }[];
  scripts?: ScriptRecord[];
  tracking_globals?: string[];
  broken_images?: { src: string | null; alt: string | null; y: number }[];
  lang?: string | null;
  has_viewport_meta?: boolean;
}

/** Everything the detectors extract from one rendered page. */
export interface PageRecord {
  url: string;
  canonical_url: string | null;
  page_type: PageType;
  classification_confidence: number;
  classification_evidence: string[];
  title: string;
  meta_description: string | null;
  timestamp: string;
  headings: HeadingRecord[];
  subheadings: HeadingRecord[];
  paragraphs: TextBlock[];
  visible_text: string;
  buttons: ButtonRecord[];
  links: LinkRecord[];
  forms: FormRecord[];
  videos: VideoRecord[];
  images: ImageRecord[];
  ctas: CtaRecord[];
  pricing: PricingRecord[];
  testimonials: TestimonialRecord[];
  faq_sections: FaqSection[];
  urgency_elements: UrgencyRecord[];
  social_proof: SocialProofRecord[];
  benefit_stack: BenefitStackItem[];
  objection_handling: ObjectionRecord[];
  attendance_bonuses: BonusRecord[];
  one_time_offer: OtoEvidence | null;
  application_friction: ApplicationFriction | null;
  cta_benefit_relationships: CtaBenefitRelationship[];
  proof_placement: ProofPlacementRecord[];
  above_the_fold: AboveTheFoldData;
  iframes: IframeRecord[];
  json_ld: unknown[];
  technical_snapshot?: PageTechnicalSnapshot;
}

export interface TrackingSignal {
  vendor: string;
  kind: "pixel" | "analytics" | "tag_manager" | "chat" | "heatmap" | "other";
  evidence: string;
  id?: string | null;
}
