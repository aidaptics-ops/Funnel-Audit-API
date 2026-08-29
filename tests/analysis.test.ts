import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BrowserManager } from "../src/browser/browser_manager.js";
import { analyzeLandingPage } from "../src/pipeline/analyze_landing.js";
import { isAllowedUrl } from "../src/api/url_guard.js";
import type { LandingAnalysis } from "../src/analysis/landing_types.js";
import type { BrowserConfig } from "../src/types/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture_server.js";

const workDir = mkdtempSync(join(tmpdir(), "analyzer-analysis-"));

// "chrome" locally, bundled Chromium in Docker/CI: the manager falls back.
const browserConfig: BrowserConfig = {
  headless: true,
  device: "desktop",
  timeout_ms: 20000,
  navigation_timeout_ms: 25000,
  browser_channel: "chrome",
};

let fixture: FixtureServer;
let browsers: BrowserManager;
let vsl: LandingAnalysis;
let minimal: LandingAnalysis;

async function analyze(path: string): Promise<LandingAnalysis> {
  const browser = await browsers.get();
  return analyzeLandingPage({
    url: fixture.url(path),
    jobId: randomUUID(),
    browser,
    config: browserConfig,
    checkMobileViewport: true,
    linkCheck: {
      enabled: true,
      maxLinks: 25,
      timeoutMs: 4000,
      concurrency: 5,
      sameOriginOnly: true,
      isAllowedUrl: (url) => isAllowedUrl(url, { allowPrivateHosts: true }),
    },
  });
}

before(async () => {
  fixture = await startFixtureServer();
  browsers = new BrowserManager(browserConfig);
  vsl = await analyze("/vsl.html");
  minimal = await analyze("/minimal.html");
});

after(async () => {
  await browsers?.close();
  await fixture?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("landing page analysis", () => {
  it("returns every documented section", () => {
    for (const key of [
      "funnel",
      "page",
      "hero",
      "headings",
      "copy",
      "videos",
      "vsl",
      "ctas",
      "forms",
      "testimonials",
      "social_proof",
      "offer",
      "guarantees",
      "pricing",
      "urgency",
      "navigation",
      "links",
      "tracking",
      "seo",
      "technical",
      "observed_issues",
    ]) {
      assert.ok(key in vsl, `missing section: ${key}`);
    }
    assert.equal("predicted_issues" in vsl, false, "predicted_issues must not exist");
    assert.equal(vsl.schema_version, "2.0");
    assert.ok(vsl.duration_ms > 0);
  });

  it("reads the page facts off the rendered document", () => {
    assert.equal(vsl.page.title, "Free Profit Audit — Northwind Coaching");
    assert.equal(vsl.page.http_status, 200);
    assert.equal(vsl.page.language, "en");
    assert.match(vsl.page.meta_description ?? "", /profit audit/i);
    assert.ok(vsl.page.dimensions.scroll_height > vsl.page.dimensions.viewport_height);
    assert.ok(vsl.page.visible_text.words > 100);
    assert.ok(vsl.page.dom.links > 5);
  });

  it("extracts the hero verbatim", () => {
    assert.equal(vsl.hero.headline, "Find the £40k leak in your funnel");
    assert.match(vsl.hero.subheadline ?? "", /coaches and agencies/i);
    assert.equal(vsl.hero.cta_above_fold, true);
    assert.equal(vsl.hero.media.kind, "video");
    assert.ok(vsl.headings.length >= 5);
    assert.equal(vsl.headings[0]?.level, 1);
  });

  it("identifies the brand without inventing one", () => {
    assert.equal(vsl.funnel.brand_name.status, "detected");
    if (vsl.funnel.brand_name.status === "detected") {
      assert.match(vsl.funnel.brand_name.value, /Northwind/i);
      assert.ok(vsl.funnel.brand_name.evidence.length > 0);
    }
    assert.equal(vsl.funnel.domain, "127.0.0.1");
  });

  it("collects business identity signals for the enrichment service", () => {
    const identity = vsl.funnel.business_identity;
    assert.ok(identity.contact_emails.includes("hello@northwind.example"));
    assert.ok(identity.social_profiles.some((profile) => profile.platform === "linkedin"));
    assert.ok(identity.organization_names.includes("Northwind Coaching"));
    assert.ok(identity.contact_phones.length >= 1);
  });
});

describe("VSL detection", () => {
  it("detects the sales video on a video-led page", () => {
    assert.equal(vsl.videos.length, 1);
    assert.equal(vsl.videos[0].provider, "youtube");
    assert.equal(vsl.videos[0].video_id, "dQw4w9WgXcQ");
    assert.equal(vsl.videos[0].above_fold, true);
    assert.equal(vsl.vsl.indicators.video_above_fold, true);
    assert.equal(vsl.vsl.indicators.single_dominant_video, true);
  });

  it("does not claim a VSL on a page with no video", () => {
    assert.equal(minimal.videos.length, 0);
    assert.equal(minimal.vsl.determination.status, "unknown");
    if (minimal.vsl.determination.status === "unknown") {
      assert.match(minimal.vsl.determination.reason, /video/i);
    }
  });
});

describe("CTA detection", () => {
  it("finds CTAs, marks exactly one primary and classifies destinations", () => {
    assert.ok(vsl.ctas.length >= 2, `expected CTAs, got ${vsl.ctas.length}`);
    assert.equal(vsl.ctas.filter((cta) => cta.is_primary).length, 1);

    const booking = vsl.ctas.find((cta) => /book my free audit/i.test(cta.text));
    assert.ok(booking, "the hero CTA should be detected");
    assert.ok(["anchor", "form_submit", "internal", "none"].includes(booking!.destination.kind));

    for (const cta of vsl.ctas) {
      assert.ok(typeof cta.above_fold === "boolean");
      assert.ok(cta.position && typeof cta.position.y === "number");
    }
  });

  it("does not treat navigation or legal links as CTAs", () => {
    const labels = vsl.ctas.map((cta) => cta.text.toLowerCase());
    for (const noise of ["privacy", "terms", "blog", "about"]) {
      assert.equal(labels.includes(noise), false, `"${noise}" should not be a CTA`);
    }
  });
});

describe("form detection without submission", () => {
  it("describes the form but never interacts with it", () => {
    assert.ok(vsl.forms.length >= 1);
    const native = vsl.forms.find((form) => form.integration === "native_html");
    assert.ok(native, "the native form should be detected");
    assert.equal(native!.interacted, false);
    assert.ok(native!.field_count >= 3);
    assert.ok(native!.fields.some((field) => field.purpose === "email"));
    assert.equal(native!.provider, "activecampaign");
    assert.ok(native!.notes.some((note) => /not interacted/i.test(note)));
  });

  it("records an off-page form link without following it", () => {
    const external = vsl.forms.find((form) => form.integration === "external_link");
    assert.ok(external, "the Typeform link should be recorded");
    assert.equal(external!.provider, "typeform");
    assert.equal(external!.interacted, false);
  });

  it("never sends a POST to the fixture server", () => {
    const posts = fixture.requests.filter((request) => request.method !== "GET" && request.method !== "HEAD");
    assert.deepEqual(posts, [], `unexpected non-GET requests: ${JSON.stringify(posts)}`);
  });
});

describe("proof, offer and pricing", () => {
  it("extracts testimonials with real attributions only", () => {
    assert.ok(vsl.testimonials.length >= 1);
    const dana = vsl.testimonials.find((item) => item.name?.includes("Dana"));
    assert.ok(dana, "the attributed testimonial should be found");
    assert.match(dana!.text, /42,000/);
  });

  it("collects logos and ratings", () => {
    assert.ok(vsl.social_proof.client_logos.length >= 2);
    assert.ok(vsl.social_proof.ratings.length >= 1 || vsl.social_proof.numeric_claims.length >= 1);
  });

  it("reads pricing and the guarantee", () => {
    assert.equal(vsl.pricing.detected, true);
    assert.ok(vsl.pricing.items.length >= 1);
    assert.equal(vsl.guarantees.detected, true);
    assert.equal(vsl.guarantees.risk_reversal_present, true);
    assert.ok(vsl.guarantees.items.some((item) => item.kind === "money_back"));
  });

  it("only reports urgency backed by concrete claims", () => {
    assert.equal(vsl.urgency.detected, true);
    assert.notEqual(vsl.urgency.evidence_quality, "none");
    assert.equal(minimal.urgency.detected, false);
    assert.equal(minimal.urgency.evidence_quality, "none");
  });

  it("never invents an audience or mechanism it cannot quote", () => {
    for (const determination of [minimal.offer.product, minimal.offer.audience, minimal.offer.mechanism]) {
      if (determination.status === "detected") {
        assert.ok(determination.evidence.length > 0, "a detected value must carry evidence");
      }
    }
    assert.equal(minimal.offer.audience.status, "unknown");
  });
});

describe("tracking detection", () => {
  it("detects the vendors present in the rendered page", () => {
    const vendors = vsl.tracking.detected.map((vendor) => vendor.vendor.toLowerCase()).join(" ");
    assert.match(vendors, /meta|facebook/);
    assert.equal(vsl.tracking.has_advertising_pixel, true);
    assert.equal(vsl.tracking.has_analytics, true);
  });

  it("phrases absence as an observation about the page", () => {
    const statements = minimal.tracking.statements.join(" ");
    assert.match(statements, /No .* was detected in the rendered page/i);
    assert.doesNotMatch(statements, /the business (does not|doesn't)/i);
  });

  it("captures real IDs when they are present", () => {
    const ids = Object.values(vsl.tracking.ids).flat().join(" ");
    assert.match(ids, /G-ABCDE12345|123456789012345/);
  });
});

describe("SEO detection", () => {
  it("reports verifiable SEO facts", () => {
    assert.equal(vsl.seo.title.present, true);
    assert.equal(vsl.seo.meta_description.present, true);
    assert.equal(vsl.seo.canonical.present, true);
    assert.equal(vsl.seo.h1.count, 1);
    assert.equal(vsl.seo.heading_structure.starts_with_h1, true);
    assert.ok(vsl.seo.structured_data.types.includes("Organization"));
    assert.equal(vsl.seo.open_graph["og:site_name"], "Northwind Coaching");
    assert.equal(vsl.seo.robots.indexable, true);
  });

  it("detects noindex", () => {
    assert.equal(minimal.seo.robots.indexable, false);
    assert.equal(minimal.seo.meta_description.present, false);
  });
});

describe("technical observations", () => {
  it("records console errors, failed requests and broken images", () => {
    assert.ok(vsl.technical.console_errors.length >= 1);
    const messages = vsl.technical.console_errors.map((error) => error.text).join(" | ");
    assert.match(messages, /Analytics bridge/, `expected the page's own error among: ${messages}`);
    assert.ok(vsl.technical.failed_requests.length >= 1);
    assert.equal(vsl.technical.https, false);
    assert.equal(vsl.technical.render.dom_content_loaded, true);
  });

  it("checks same-origin links and reports the broken one", () => {
    assert.ok(vsl.links.checked.length >= 1);
    assert.ok(vsl.links.broken.some((link) => link.url.includes("/missing-page")));
    assert.ok(vsl.links.social.some((link) => link.platform === "linkedin"));
    assert.ok(vsl.links.mailto.includes("hello@northwind.example"));
  });

  it("observes the mobile viewport separately", () => {
    assert.equal(vsl.technical.mobile.tested, true);
    assert.equal(vsl.technical.mobile.viewport_meta_present, true);
  });
});

describe("observed issues", () => {
  it("only emits issues that carry evidence", () => {
    for (const analysis of [vsl, minimal]) {
      for (const issue of analysis.observed_issues) {
        assert.ok(issue.evidence.length > 0, `${issue.id} has no evidence`);
        assert.ok(issue.recommendation.length > 0, `${issue.id} has no recommendation`);
        assert.ok(["critical", "high", "medium", "low"].includes(issue.severity));
      }
    }
  });

  it("flags the real problems on the thin page", () => {
    const ids = minimal.observed_issues.map((issue) => issue.id);
    assert.ok(ids.includes("NOINDEX_DETECTED"), `expected NOINDEX_DETECTED in ${ids.join(",")}`);
    assert.ok(ids.includes("MISSING_H1"));
    assert.ok(ids.includes("THIN_COPY"));
    assert.ok(ids.includes("MISSING_META_DESCRIPTION"));
  });

  it("does not invent problems on a complete page", () => {
    const ids = vsl.observed_issues.map((issue) => issue.id);
    assert.equal(ids.includes("NO_CTA_DETECTED"), false);
    assert.equal(ids.includes("MISSING_H1"), false);
    assert.equal(ids.includes("NO_VISIBLE_SOCIAL_PROOF"), false);
    assert.equal(ids.includes("NO_ANALYTICS_DETECTED"), false);
    assert.equal(ids.includes("NO_GUARANTEE_OR_RISK_REVERSAL"), false);
    assert.equal(ids.includes("THIN_COPY"), false);
    // The fixture genuinely has a broken image and a dead link.
    assert.ok(ids.includes("BROKEN_IMAGES"));
  });

  it("keeps the summary in step with the issues", () => {
    assert.equal(vsl.summary.issues.total, vsl.observed_issues.length);
    const critical = vsl.observed_issues.filter((issue) => issue.severity === "critical").length;
    assert.equal(vsl.summary.issues.by_severity.critical, critical);
  });
});

describe("repeatability", () => {
  it("analyses several pages in sequence with one browser", async () => {
    const optin = await analyze("/optin.html");
    assert.equal(optin.page.title, "Free funnel leak checklist | Northwind");
    assert.ok(optin.forms.length >= 1);
    assert.equal(browsers.connected, true, "the browser is reused, not relaunched");

    const again = await analyze("/optin.html");
    assert.equal(again.hero.headline, optin.hero.headline);
    assert.equal(again.seo.h1.count, optin.seo.h1.count);
  });

  it("follows redirects to the final URL", async () => {
    const redirected = await analyze("/go");
    assert.match(redirected.page.final_url, /vsl\.html$/);
    assert.equal(redirected.funnel.redirected, true);
    assert.ok(redirected.funnel.redirect_chain.length >= 2);
  });
});
