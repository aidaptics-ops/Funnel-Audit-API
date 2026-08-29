import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BrowserManager } from "../src/browser/browser_manager.js";
import { analyzeLandingPage } from "../src/pipeline/analyze_landing.js";
import { isAllowedUrl } from "../src/api/url_guard.js";
import type { LandingAnalysis, ObservedIssue } from "../src/analysis/landing_types.js";
import type { BrowserConfig } from "../src/types/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture_server.js";

const workDir = mkdtempSync(join(tmpdir(), "analyzer-audit-"));

const browserConfig: BrowserConfig = {
  headless: true,
  device: "desktop",
  timeout_ms: 20000,
  navigation_timeout_ms: 25000,
  browser_channel: "chrome",
};

let fixture: FixtureServer;
let browsers: BrowserManager;
let application: LandingAnalysis;

const issue = (analysis: LandingAnalysis, id: string): ObservedIssue | undefined =>
  analysis.observed_issues.find((entry) => entry.id === id);

before(async () => {
  fixture = await startFixtureServer();
  browsers = new BrowserManager(browserConfig);
  const browser = await browsers.get();
  application = await analyzeLandingPage({
    url: fixture.url("/application.html"),
    jobId: randomUUID(),
    browser,
    config: browserConfig,
    checkMobileViewport: false,
    linkCheck: {
      enabled: false,
      maxLinks: 0,
      timeoutMs: 2000,
      concurrency: 2,
      sameOriginOnly: true,
      isAllowedUrl: (url) => isAllowedUrl(url, { allowPrivateHosts: true }),
    },
  });
});

after(async () => {
  await browsers?.close();
  await fixture?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("CTA and form are one conversion action", () => {
  it("detects the submit button as a CTA and links it to its form", () => {
    const submit = application.ctas.find((cta) => /submit/i.test(cta.text));
    assert.ok(submit, "the SUBMIT button must be detected as a CTA");
    assert.equal(submit!.is_form_submit, true);
    assert.equal(submit!.form_index, 0, "the CTA must point at the form it submits");
    assert.equal(typeof submit!.position.y, "number");
    assert.equal(typeof submit!.position.x, "number");
    assert.equal(submit!.is_primary, true, "a bare SUBMIT is still the conversion action");
  });

  it("does not call the page CTA-less when the form is above the fold", () => {
    assert.equal(issue(application, "NO_CTA_DETECTED"), undefined);

    const aboveFold = issue(application, "NO_CTA_ABOVE_FOLD");
    if (aboveFold) {
      // It may still fire, but only as a refinement, never as a high-severity
      // "there is no call to action" claim.
      assert.ok(
        ["low", "informational"].includes(aboveFold.severity),
        `expected a downgraded severity, got ${aboveFold.severity}`,
      );
      assert.match(aboveFold.description, /form is inside the first viewport/i);
      assert.ok(aboveFold.evidence.some((line) => /form starts at y=/.test(line)));
    }
  });
});

describe("third-party technical noise", () => {
  it("classifies every console error and failed request by party", () => {
    for (const error of application.technical.console_errors) {
      assert.ok(error.party, "each console error carries a party");
    }
    for (const failure of application.technical.failed_requests) {
      assert.ok(failure.party, "each failed request carries a party");
    }
  });

  it("never raises a third-party failure above informational on a rendered page", () => {
    for (const id of ["CONSOLE_ERRORS", "FAILED_REQUESTS"]) {
      const found = issue(application, id);
      if (!found) continue;
      const events =
        id === "CONSOLE_ERRORS"
          ? application.technical.console_errors
          : application.technical.failed_requests;
      const firstParty = events.filter((event) => event.party === "first_party");
      if (firstParty.length) continue;
      assert.equal(found.severity, "informational", `${id} was ${found.severity} with no first-party cause`);
      assert.match(found.impact ?? "", /no conversion impact/i);
    }
  });
});

describe("context-aware severity", () => {
  it("treats missing social proof on an application funnel as an opportunity", () => {
    const found = issue(application, "NO_VISIBLE_SOCIAL_PROOF");
    if (found) {
      assert.ok(["low", "medium"].includes(found.severity), `got ${found.severity}`);
      assert.match(found.description, /No testimonials/i);
      assert.ok(found.impact, "a contextual finding explains its impact");
    }
  });

  it("never treats an absent price as a problem on an application funnel", () => {
    const found = issue(application, "OFFER_CLARITY_UNCLEAR");
    if (found) {
      const stated = `${found.description} ${found.evidence.join(" ")}`;
      const expectedLine = found.evidence.find((line) => /expected on/.test(line)) ?? "";
      assert.doesNotMatch(expectedLine, /price/i, "price must not be listed as expected here");
      assert.ok(stated.length > 0);
    }
  });

  it("qualifies analytics absence instead of asserting it", () => {
    const found = issue(application, "NO_ANALYTICS_DETECTED");
    if (found) {
      assert.ok(["medium", "low", "informational"].includes(found.severity), `got ${found.severity}`);
      assert.match(found.description, /observable during this rendered session/i);
      assert.doesNotMatch(found.description, /does not use|has no analytics/i);
    }
    // Whether or not it fires, the statements must describe the page, not the business.
    for (const statement of application.tracking.statements) {
      assert.doesNotMatch(statement, /the business/i);
    }
  });

  it("gives every issue a severity from the five-point scale, with evidence", () => {
    const allowed = new Set(["critical", "high", "medium", "low", "informational"]);
    for (const entry of application.observed_issues) {
      assert.ok(allowed.has(entry.severity), `${entry.id}: ${entry.severity}`);
      assert.ok(entry.evidence.length > 0, `${entry.id} has no evidence`);
      assert.ok(entry.recommendation.length > 0, `${entry.id} has no recommendation`);
      if (entry.confidence !== undefined) {
        assert.ok(entry.confidence >= 0 && entry.confidence <= 1);
      }
    }
  });

  it("reserves critical for demonstrated failures", () => {
    // NOT_HTTPS is expected: the fixture server speaks plain http. Nothing else
    // on this page is broken, so nothing else may be critical.
    const critical = application.observed_issues
      .filter((entry) => entry.severity === "critical")
      .filter((entry) => entry.id !== "NOT_HTTPS");
    assert.deepEqual(critical.map((entry) => entry.id), []);
  });
});

describe("hidden content does not create findings", () => {
  it("separates DOM headings from visible headings", () => {
    const structure = application.seo.heading_structure;
    assert.ok(structure.dom_heading_count > structure.visible_heading_count, "the fixture hides a heading block");
    assert.equal(application.seo.h1.count, 2, "two h1s exist in the DOM");
    assert.equal(application.seo.h1.visible_count, 1, "only one is visible");
  });

  it("does not report multiple H1s when only one is visible", () => {
    assert.equal(issue(application, "MULTIPLE_H1"), undefined);
  });

  it("bases heading-hierarchy findings on the visible outline", () => {
    const found = issue(application, "BROKEN_HEADING_HIERARCHY");
    if (found) {
      assert.equal(found.severity, "informational");
      assert.ok(found.evidence.some((line) => /Visible heading/.test(line)));
    }
  });
});

describe("counts agree with each other", () => {
  it("reports one reconciled set of video metrics", () => {
    const videos = application.summary.videos;
    assert.equal(videos.dom_count, application.videos.length);
    assert.ok(videos.visible_count <= videos.dom_count);
    assert.ok(videos.above_fold_count <= videos.visible_count);
    assert.ok(videos.analyzable_count <= videos.visible_count);
    assert.equal(videos.total, videos.dom_count, "the legacy alias still matches");
  });
});

describe("brand extraction", () => {
  it("does not treat the copyright year as part of the brand", () => {
    const brand = application.funnel.brand_name;
    if (brand.status === "detected") {
      assert.doesNotMatch(brand.value, /\d{4}/, `brand still carries a year: ${brand.value}`);
      assert.match(brand.value, /RealSide Real Estate/);
      assert.ok(brand.evidence.length > 0);
    }
    // The raw line is still preserved separately for the enrichment service.
    assert.ok(
      application.funnel.business_identity.copyright_holders.some((line) => /2026/.test(line)),
      "the literal copyright line must be preserved",
    );
  });
});
