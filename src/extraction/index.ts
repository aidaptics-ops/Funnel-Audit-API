import type { Page } from "playwright";
import type { DomSnapshot, PageRecord, PageType } from "../types/index.js";
import { classifyPage } from "../classification/page_classifier.js";
import { extractAboveTheFold } from "./above_fold.js";
import {
  ctaBenefitRelationships,
  detectBenefitStack,
  detectBonuses,
  detectObjections,
  detectOto,
  detectProofPlacement,
  primaryApplicationFriction,
} from "./conversion_detector.js";
import { detectCtas } from "./cta_detector.js";
import { captureDomSnapshot } from "./dom_snapshot.js";
import { detectFaqs } from "./faq_detector.js";
import { inspectEmbeddedForms } from "./embedded_form_inspector.js";
import { isFormEmbedSrc, isCalendarEmbedSrc } from "./embed_hosts.js";
import { extractForms } from "./form_extractor.js";
import { detectPricing } from "./pricing_detector.js";
import { detectTestimonials, detectSocialProof } from "./testimonial_detector.js";
import { extractText } from "./text_extractor.js";
import { detectUrgency } from "./urgency_detector.js";
import { detectVideos } from "./video_detector.js";

export async function extractPageEvidence(
  page: Page,
  extras?: {
    classificationHint?: PageType;
    viewportScreenshot?: string | null;
    typeformPayloads?: unknown[];
  },
): Promise<{ record: PageRecord; snapshot: DomSnapshot }> {
  const snapshot = await captureDomSnapshot(page);
  const text = extractText(snapshot);
  const nativeForms = extractForms(snapshot);
  const embedded = await inspectEmbeddedForms(page, snapshot.iframes, extras?.typeformPayloads || []);
  const forms = mergeForms(nativeForms, embedded.forms);

  for (const iframe of snapshot.iframes) {
    if (!iframe.src) continue;
    const update = embedded.iframeUpdates.get(iframe.src);
    if (update) Object.assign(iframe, update);
    else if (isFormEmbedSrc(iframe.src) || isCalendarEmbedSrc(iframe.src)) {
      if (!iframe.inspectable) {
        iframe.limitation =
          iframe.limitation ||
          "Embedded form iframe detected; interaction uses Playwright frame APIs";
      }
    }
  }

  const videos = detectVideos(snapshot);
  const ctas = detectCtas(snapshot);
  const classification = classifyPage({ snapshot, forms, videos, ctas });
  const pageType = extras?.classificationHint || classification.page_type;
  const evidence = extras?.classificationHint
    ? [`funnel checkpoint: ${extras.classificationHint}`, ...classification.evidence]
    : classification.evidence;

  const testimonials = detectTestimonials(snapshot);
  const socialProof = detectSocialProof(snapshot, testimonials);
  const faqs = detectFaqs(snapshot);
  const pricing = detectPricing(snapshot);
  const urgency = detectUrgency(snapshot);
  const benefitStack = detectBenefitStack(snapshot);
  const objections = detectObjections(snapshot);
  const bonuses = detectBonuses(snapshot);
  const oto = detectOto(snapshot, pageType, pricing, ctas);

  const record: PageRecord = {
    url: snapshot.url,
    canonical_url: snapshot.meta.canonical,
    page_type: pageType,
    classification_confidence: classification.confidence,
    classification_evidence: evidence,
    title: snapshot.title,
    meta_description: snapshot.meta.description,
    timestamp: new Date().toISOString(),
    headings: text.headings,
    subheadings: text.subheadings,
    paragraphs: text.paragraphs.slice(0, 200),
    visible_text: text.visible_text,
    buttons: snapshot.buttons,
    links: snapshot.links,
    forms,
    videos,
    images: snapshot.images,
    ctas,
    pricing,
    testimonials,
    faq_sections: faqs,
    urgency_elements: urgency,
    social_proof: socialProof,
    benefit_stack: benefitStack,
    objection_handling: objections,
    attendance_bonuses: bonuses,
    one_time_offer: oto.detected ? oto : null,
    application_friction: primaryApplicationFriction(forms),
    cta_benefit_relationships: ctaBenefitRelationships(ctas),
    proof_placement: detectProofPlacement(snapshot, testimonials, videos, ctas),
    above_the_fold: extractAboveTheFold({
      snapshot,
      ctas,
      videos,
      pricing,
      proof: socialProof,
      objections,
      viewportScreenshot: extras?.viewportScreenshot ?? null,
    }),
    iframes: snapshot.iframes,
    json_ld: snapshot.json_ld,
    technical_snapshot: {
      scripts: snapshot.scripts || [],
      tracking_globals: snapshot.tracking_globals || [],
      broken_images: snapshot.broken_images || [],
      images_missing_alt: snapshot.images.filter((image) => image.visible && !image.alt).length,
      language: snapshot.lang ?? null,
      has_viewport_meta: snapshot.has_viewport_meta ?? false,
      body_overflow_x: snapshot.body_overflow_x,
      viewport: snapshot.viewport,
    },
  };

  return { record, snapshot };
}

function mergeForms(
  nativeForms: ReturnType<typeof extractForms>,
  embeddedForms: ReturnType<typeof extractForms>,
) {
  const out = [...nativeForms];
  for (const form of embeddedForms) {
    const duplicate = out.some(
      (existing) => existing.action && form.action && existing.action === form.action,
    );
    if (!duplicate) out.push(form);
  }
  return out;
}

export { captureDomSnapshot } from "./dom_snapshot.js";
export { detectCtas } from "./cta_detector.js";
export { extractForms } from "./form_extractor.js";
