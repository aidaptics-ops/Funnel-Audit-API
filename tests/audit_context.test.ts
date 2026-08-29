import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyParty } from "../src/analysis/audit/party.js";
import { buildAuditContext, severityForMissing, withArticle } from "../src/analysis/audit/context.js";
import { downgrade, temperByConfidence, upgrade } from "../src/analysis/audit/severity.js";
import type { LandingAnalysis } from "../src/analysis/landing_types.js";

const PAGE_URL = "https://realsidecommunity.com/opt-in";

describe("first-party vs third-party classification", () => {
  it("treats the analysed domain's own assets as first-party", () => {
    for (const url of [
      "https://realsidecommunity.com/app.js",
      "https://cdn.realsidecommunity.com/bundle.js",
      "https://realsidecommunity.com/a/b/c.css",
    ]) {
      assert.equal(classifyParty(url, PAGE_URL).party, "first_party", url);
    }
  });

  it("recognises bot-mitigation infrastructure rather than blaming the funnel", () => {
    const turnstile = classifyParty(
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0",
      PAGE_URL,
    );
    assert.equal(turnstile.party, "security_infrastructure");
    assert.equal(turnstile.vendor, "Cloudflare Turnstile");

    assert.equal(
      classifyParty("https://brunhild.challenges.cloudflare.com/cdn-cgi/x", PAGE_URL).party,
      "security_infrastructure",
    );
    assert.equal(classifyParty("https://hcaptcha.com/1/api.js", PAGE_URL).party, "security_infrastructure");
  });

  it("separates analytics endpoints from ordinary third parties", () => {
    assert.equal(classifyParty("https://www.google-analytics.com/g/collect", PAGE_URL).party, "analytics");
    assert.equal(classifyParty("https://static.cloudflareinsights.com/beacon.js", PAGE_URL).party, "analytics");
    assert.equal(classifyParty("https://stcdn.leadconnectorhq.com/x.js", PAGE_URL).party, "third_party");
  });

  it("attributes browser-generated noise to the browser", () => {
    const result = classifyParty(null, PAGE_URL, "Third-party cookie will be blocked in future");
    assert.equal(result.party, "browser");
  });
});

describe("severity arithmetic", () => {
  it("moves along the five-point scale", () => {
    assert.equal(downgrade("high"), "medium");
    assert.equal(downgrade("low"), "informational");
    assert.equal(downgrade("informational"), "informational");
    assert.equal(upgrade("medium"), "high");
    assert.equal(upgrade("critical"), "critical");
  });

  it("softens funnel-specific judgements when the funnel read is weak", () => {
    assert.equal(temperByConfidence("high", 0.3), "medium");
    assert.equal(temperByConfidence("high", 0.8), "high");
    // Low findings are already cautious; confidence does not move them.
    assert.equal(temperByConfidence("low", 0.1), "low");
  });

  it("maps an expectation to a severity", () => {
    assert.equal(severityForMissing("expected"), "medium");
    assert.equal(severityForMissing("optional"), "low");
    assert.equal(severityForMissing("irrelevant"), "informational");
  });

  it("gets the article right", () => {
    assert.equal(withArticle("application funnel"), "an application funnel");
    assert.equal(withArticle("sales page"), "a sales page");
    assert.equal(withArticle("opt-in page"), "an opt-in page");
  });
});

/** Minimal analysis stub: only the fields buildAuditContext reads. */
function analysisStub(overrides: Record<string, unknown> = {}): Omit<LandingAnalysis, "observed_issues"> {
  const base = {
    funnel: {
      funnel_type: { status: "detected", value: "application", confidence: 0.75, evidence: [] },
      primary_conversion_goal: { status: "detected", value: "submit_application", confidence: 0.7, evidence: [] },
      page_type_classification: { page_type: "application", confidence: 0.9, evidence: [] },
    },
    page: {
      dimensions: { fold_height: 900, viewport_height: 900 },
      http_status: 200,
      dom: { paragraphs: 8 },
    },
    copy: { word_count: 214 },
    headings: [{ visible: true }],
    forms: [
      {
        integration: "orphan_fields",
        location: { above_fold: true, visible: true, y: 595 },
      },
    ],
    ctas: [{ above_fold: false, visible: true, destination: { kind: "form_submit", url: null } }],
  };
  return { ...base, ...overrides } as unknown as Omit<LandingAnalysis, "observed_issues">;
}

describe("audit context", () => {
  it("reads the funnel, the goal and the conversion path", () => {
    const ctx = buildAuditContext(analysisStub());
    assert.equal(ctx.funnel_type, "application");
    assert.equal(ctx.conversion_goal, "submit_application");
    assert.equal(ctx.conversion_path, "form");
    assert.equal(ctx.label, "application funnel");
    assert.equal(ctx.page_rendered, true);
  });

  it("counts a form above the fold as an above-the-fold conversion path", () => {
    const ctx = buildAuditContext(analysisStub());
    assert.equal(ctx.form_above_fold, true);
    // The submit button is below the fold, but the visitor can still start.
    assert.equal(ctx.conversion_visible_above_fold, true);
  });

  it("does not claim an above-the-fold path when the form is far down", () => {
    const ctx = buildAuditContext(
      analysisStub({
        forms: [{ integration: "native_html", location: { above_fold: false, visible: true, y: 2400 } }],
      }),
    );
    assert.equal(ctx.form_above_fold, false);
    assert.equal(ctx.conversion_visible_above_fold, false);
  });

  it("knows what each funnel type is expected to state", () => {
    const application = buildAuditContext(analysisStub());
    assert.equal(application.expects.price, "irrelevant");

    const sales = buildAuditContext(
      analysisStub({
        funnel: {
          funnel_type: { status: "detected", value: "sales_page", confidence: 0.8, evidence: [] },
          primary_conversion_goal: { status: "detected", value: "purchase", confidence: 0.8, evidence: [] },
          page_type_classification: { page_type: "sales_page", confidence: 0.8, evidence: [] },
        },
      }),
    );
    assert.equal(sales.expects.price, "expected");
    assert.equal(sales.expects.proof, "expected");

    const leadMagnet = buildAuditContext(
      analysisStub({
        funnel: {
          funnel_type: { status: "detected", value: "lead_magnet", confidence: 0.8, evidence: [] },
          primary_conversion_goal: { status: "unknown", reason: "x" },
          page_type_classification: { page_type: "optin", confidence: 0.8, evidence: [] },
        },
      }),
    );
    assert.equal(leadMagnet.expects.price, "irrelevant");
  });

  it("falls back to neutral expectations when the funnel type is unknown", () => {
    const ctx = buildAuditContext(
      analysisStub({
        funnel: {
          funnel_type: { status: "unknown", reason: "insufficient evidence" },
          primary_conversion_goal: { status: "unknown", reason: "insufficient evidence" },
          page_type_classification: { page_type: "unknown", confidence: 0, evidence: [] },
        },
      }),
    );
    assert.equal(ctx.funnel_type, "unknown");
    assert.equal(ctx.classification_confidence, 0);
    assert.equal(ctx.expects.price, "optional");
  });

  it("notices when the page did not really render", () => {
    const ctx = buildAuditContext(analysisStub({ copy: { word_count: 4 }, headings: [] }));
    assert.equal(ctx.page_rendered, false);
  });
});
