import type {
  AboveTheFoldData,
  CtaRecord,
  DomSnapshot,
  ObjectionRecord,
  PricingRecord,
  SocialProofRecord,
  VideoRecord,
} from "../types/index.js";

export function extractAboveTheFold(input: {
  snapshot: DomSnapshot;
  ctas: CtaRecord[];
  videos: VideoRecord[];
  pricing: PricingRecord[];
  proof: SocialProofRecord[];
  objections: ObjectionRecord[];
  viewportScreenshot: string | null;
}): AboveTheFoldData {
  const { snapshot, ctas, videos, pricing, proof, objections, viewportScreenshot } = input;
  const heroHeading =
    snapshot.headings.find((h) => h.visible && h.position === "above_fold" && h.level === 1)?.text ||
    snapshot.headings.find((h) => h.visible && h.position === "above_fold")?.text ||
    null;
  const heroSubheading =
    snapshot.paragraphs.find((p) => p.visible && p.position === "above_fold" && p.text.length > 20)?.text ||
    snapshot.headings.find(
      (h) => h.visible && h.position === "above_fold" && h.text !== heroHeading && h.level >= 2,
    )?.text ||
    null;

  const primaryCta =
    ctas.find((c) => c.visible && c.position === "above_fold") ||
    ctas.find((c) => c.visible) ||
    null;

  const offerBits = [heroHeading, heroSubheading, primaryCta?.text].filter(Boolean).join(" — ");

  return {
    hero_heading: heroHeading,
    hero_subheading: heroSubheading ? heroSubheading.slice(0, 400) : null,
    primary_cta: primaryCta,
    primary_offer: offerBits || null,
    first_visible_proof:
      proof.find((p) => p.position === "above_fold")?.text ||
      proof[0]?.text ||
      null,
    first_visible_objection_handling:
      objections.find((o) => o.position === "above_fold")?.text ||
      objections[0]?.text ||
      null,
    first_visible_price:
      pricing.find((p) => p.position === "above_fold")?.amount ||
      pricing[0]?.amount ||
      null,
    first_visible_video:
      videos.find((v) => v.visible && v.position === "above_fold") ||
      videos.find((v) => v.visible) ||
      null,
  };
}
