/**
 * The evidence layer's own contract.
 *
 * The rule these tests defend is narrow and load-bearing: a collection that was
 * cut short must say so. Downstream, a model is forbidden from concluding
 * "there is no X on this page" over a field the ledger marks incomplete, which
 * only works if a cap can never fire silently. A silent cap here is not a
 * performance detail — it is a truncated list arriving as an absence.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { BrowserManager } from "../src/browser/browser_manager.js";
import { createContext } from "../src/browser/context_manager.js";
import { analyzeLandingPage } from "../src/pipeline/analyze_landing.js";
import { captureRenderedHtml } from "../src/pipeline/raw_html.js";
import { isAllowedUrl } from "../src/api/url_guard.js";
import type { LandingAnalysis } from "../src/analysis/landing_types.js";
import type { BrowserConfig } from "../src/types/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture_server.js";

const browserConfig: BrowserConfig = {
  headless: true,
  device: "desktop",
  timeout_ms: 20000,
  navigation_timeout_ms: 25000,
  browser_channel: "chrome",
};

const allow = (url: string): boolean => isAllowedUrl(url, { allowPrivateHosts: true });

let fixture: FixtureServer;
let browsers: BrowserManager;
/** The overflow fixture: more meta and link tags than the collectors will keep. */
let overflow: LandingAnalysis;
/** The same page under the light profile, with the pictures asked for. */
let light: LandingAnalysis;
/** The edges: sub-20px icons, element ids that look like vendors, orphan hidden inputs. */
let edges: LandingAnalysis;

before(async () => {
  fixture = await startFixtureServer();
  browsers = new BrowserManager(browserConfig);
  const browser = await browsers.get();

  const run = (profile: "full" | "light", path = "/overflow.html"): Promise<LandingAnalysis> =>
    analyzeLandingPage({
      url: fixture.url(path),
      jobId: randomUUID(),
      browser,
      config: browserConfig,
      // Both set deliberately: the light profile has to override them, and a
      // test that switched them off itself would prove nothing.
      checkMobileViewport: true,
      screenshot: true,
      captureProfile: profile,
      linkCheck: {
        enabled: true,
        maxLinks: 10,
        timeoutMs: 4000,
        concurrency: 4,
        sameOriginOnly: true,
        isAllowedUrl: allow,
      },
      isAllowedUrl: allow,
    });

  overflow = await run("full");
  light = await run("light");
  edges = await run("full", "/evidence-edges.html");
});

after(async () => {
  await browsers?.close();
  await fixture?.close();
});

describe("declared incompleteness", () => {
  it("emits a completeness entry for every capped collection", () => {
    const rows = new Map(overflow.raw_evidence.completeness.map((row) => [row.field, row]));

    // Each envelope in raw_evidence, paired with the ledger row that has to
    // exist for it. A field here with no row is a cap firing silently.
    const pairs: [string, string][] = [
      ["meta", "meta_all"],
      ["links_rel", "links_rel"],
      ["paragraphs", "paragraphs"],
      ["links", "links"],
      ["buttons", "buttons"],
      ["images", "images"],
      ["scripts", "scripts"],
      ["iframes_embeds", "embeds"],
      ["visible_text", "visible_text"],
      ["forms", "forms"],
      ["headings", "headings"],
    ];

    for (const [field, ledgerField] of pairs) {
      assert.ok(rows.has(ledgerField), `no completeness row for ${field} (ledger: ${ledgerField})`);
    }

    for (const row of overflow.raw_evidence.completeness) {
      assert.equal(typeof row.captured, "number", `${row.field}.captured`);
      assert.equal(typeof row.total, "number", `${row.field}.total`);
      assert.equal(row.complete, row.captured === row.total, `${row.field}.complete disagrees with its counts`);
      assert.ok(row.captured <= row.total, `${row.field} kept more than it saw`);
    }
  });

  it("reports complete:false for a field the cap truncated", () => {
    const evidence = overflow.raw_evidence;

    // The fixture declares 340+ meta tags against a cap of 300, and 230 link
    // rels against 200, so both of these are truncated by construction.
    assert.equal(evidence.meta.truncated, true, "the meta cap did not fire");
    assert.ok(evidence.meta.total > evidence.meta.items.length, "meta total does not exceed what was kept");
    assert.equal(evidence.links_rel.truncated, true, "the link[rel] cap did not fire");

    const rows = new Map(evidence.completeness.map((row) => [row.field, row]));
    assert.equal(rows.get("meta_all")?.complete, false, "meta_all claims completeness after truncating");
    assert.equal(rows.get("links_rel")?.complete, false, "links_rel claims completeness after truncating");
    assert.equal(rows.get("meta_all")?.cap, evidence.meta.cap, "the envelope and the ledger disagree on the cap");
  });

  it("keeps every form, including the search form the judged section drops", () => {
    const evidence = overflow.raw_evidence;
    const actions = evidence.forms.map((form) => form.action ?? "");
    assert.ok(
      actions.some((action) => action.includes("/search")),
      `the search form was filtered out of the raw evidence: ${JSON.stringify(actions)}`,
    );

    const signup = evidence.forms.find((form) => form.id === "signup-form");
    assert.ok(signup, "the named form was not carried");
    assert.equal(signup.name, "signup");
    assert.equal(signup.action_host, "forms.example.com");
    assert.equal(signup.submit_text, "Get the guide");

    // The hidden inputs are reported as existing and as carrying a value; the
    // value itself is never read, so it cannot leak into the payload.
    const csrf = signup.hidden_inputs.find((input) => input.name === "csrf");
    assert.ok(csrf, "the hidden csrf input was not attached to its form");
    assert.equal(csrf.value_present, true);
    // Scoped to the whole section, not to `forms`: the value was reported as
    // absent while it sat in `html.body_skeleton`, a sibling field of the same
    // object, and an assertion over one field could not see it.
    assert.doesNotMatch(JSON.stringify(evidence), /abc123/, "a hidden input value leaked");

    const email = signup.fields.find((field) => field.name === "email");
    assert.ok(email, "the email field was not carried");
    assert.equal(email.tag, "input");
    assert.equal(email.label, "Work email");
    assert.equal(email.required, true);
    assert.equal(email.autocomplete, "email");
    const size = signup.fields.find((field) => field.name === "size");
    assert.deepEqual(size?.options, ["Solo", "Team"]);
  });

  it("reports an embed's raw host without naming the vendor", () => {
    const hosts = overflow.raw_evidence.iframes_embeds.items.map((embed) => embed.host);
    assert.ok(hosts.includes("calendly.com"), `the embed host was not reported: ${JSON.stringify(hosts)}`);
    // Nothing in the evidence may pre-chew this into a label.
    const serialised = JSON.stringify(overflow.raw_evidence);
    assert.doesNotMatch(serialised, /"provider"\s*:/, "raw evidence must not label a provider");
  });
});

describe("evidence that must not become a judgement", () => {
  it("keeps a sub-20px icon as evidence without counting it as an image", () => {
    // Seven 16x16 icons with an empty alt, one of which 404s, plus one real
    // picture. The judged sections read the filtered list, because a tracking
    // pixel counted as a visible image arrives as a missing alt and a spacer
    // gif that never loads arrives as a broken image.
    assert.equal(edges.seo.images.total, 1, "the judged image count picked up the icons");
    assert.equal(edges.seo.images.missing_alt, 0, "a decorative 16px icon was judged as missing alt");
    assert.equal(edges.page.dom.images, 1, "the page section counted the icons");

    const ids = edges.observed_issues.map((issue) => issue.id);
    assert.ok(!ids.includes("IMAGES_MISSING_ALT"), "seven decorative icons became an accessibility finding");
    assert.ok(!ids.includes("BROKEN_IMAGES"), "a 16px icon that failed to load became a broken image");

    // The raw section keeps every one of them, which is the whole point: the
    // filter is a judgement, and this is the layer that does not make one.
    const images = edges.raw_evidence.images;
    assert.equal(images.items.length, 8, `raw evidence dropped an image: ${images.items.length}`);
    assert.ok(
      images.items.some((image) => image.meets_size_threshold === false),
      "the sub-threshold images are missing from the raw evidence",
    );

    const rows = new Map(edges.raw_evidence.completeness.map((row) => [row.field, row]));
    assert.equal(rows.get("images_all")?.complete, true, "the unfiltered list claims to be short");
    assert.equal(rows.get("images")?.complete, false, "the filtered list claims to be everything");
    assert.equal(rows.get("images")?.total, 8, "the filtered row does not count what the page held");
  });

  it("does not report a vendor global for an element id", () => {
    // <div id="Cal">, <div id="Calendly">, <div id="Stripe"> and an iframe
    // named Typeform, on a page that loads no vendor script at all. Named
    // element access puts every one of those on window, and a name reported
    // here is fabricated evidence of a third-party service.
    const globals = edges.raw_evidence.window_globals_present;
    for (const name of ["Cal", "Calendly", "Stripe", "Typeform"]) {
      assert.ok(
        !globals.includes(name),
        `an element id was reported as the global ${name}: ${JSON.stringify(globals)}`,
      );
    }
  });

  it("carries the hidden inputs that belong to no form", () => {
    // Two forms, so there is no single form to attach a body-level input to.
    // The ledger counts these document-wide; without a document-wide field to
    // put them in, it would certify a collection the payload never carried.
    const evidence = edges.raw_evidence;
    assert.equal(evidence.forms.length, 2, "the fixture no longer has two forms");

    const names = evidence.hidden_inputs.items.map((input) => input.name);
    assert.ok(names.includes("utm_campaign"), `an orphan hidden input was dropped: ${JSON.stringify(names)}`);
    assert.ok(names.includes("lead_source"), `an orphan hidden input was dropped: ${JSON.stringify(names)}`);
    assert.ok(names.includes("csrf"), "a form's own hidden input is missing from the document-wide list");

    const orphan = evidence.hidden_inputs.items.find((input) => input.name === "utm_campaign");
    assert.equal(orphan?.form_selector, null, "an input outside every form named an owner");
    assert.equal(orphan?.value_present, true);

    const row = edges.raw_evidence.completeness.find((entry) => entry.field === "hidden_inputs");
    assert.ok(row, "no completeness row for hidden_inputs");
    assert.equal(row.complete, true);
    assert.equal(
      row.captured,
      evidence.hidden_inputs.items.length,
      "the ledger counts hidden inputs the payload does not carry",
    );
  });

  it("never ships a hidden input value, in any field", () => {
    const serialised = JSON.stringify(edges);
    for (const secret of ["spring-secret-9x1", "ads-secret-7k2", "csrf-secret-5m3"]) {
      assert.doesNotMatch(serialised, new RegExp(secret), `a hidden input value leaked: ${secret}`);
    }

    // The name and the existence of the input both stay: they are evidence of
    // what the form posts. Only the value goes.
    const skeleton = edges.raw_evidence.html.body_skeleton ?? "";
    assert.ok(skeleton.includes('name="utm_campaign"'), "the markup lost the hidden input itself");
    assert.ok(skeleton.includes("[elided"), "no elision note was left where the value was");
  });

  it("splits head from body at the element, not at a string in a script", () => {
    const html = edges.raw_evidence.html;
    // The head script holds the literal text "<body class=trap>". A split on
    // the first match cuts the head mid-script and reports the rest of the head
    // as the page body.
    assert.ok(
      html.head.includes('name="description"'),
      "the head was cut short at a string inside a script",
    );
    assert.ok(html.head.includes('rel="canonical"'), "the canonical link was reported as page body");
    assert.ok(
      (html.body_skeleton ?? "").startsWith("<body"),
      `the body skeleton does not begin at the body element: ${(html.body_skeleton ?? "").slice(0, 80)}`,
    );
    assert.ok(
      !(html.body_skeleton ?? "").includes('rel="canonical"'),
      "head markup leaked into the body skeleton",
    );
  });

  it("declares the cap on a select's options", () => {
    const country = edges.raw_evidence.forms
      .flatMap((form) => form.fields)
      .find((field) => field.name === "country");
    assert.ok(country, "the select field was not carried");
    assert.equal(country.options.length, 50, "the option cap moved");

    // A country list cut at 50 with nothing saying so reads as a checkout that
    // does not ship to the country a reader asked about.
    const row = edges.raw_evidence.completeness.find((entry) => entry.field === "forms.fields.options");
    assert.ok(row, "the option cap fires with no completeness row behind it");
    assert.equal(row.complete, false, "50 of 60 options is reported as complete");
    assert.ok(row.total >= 60, `the ledger counted ${row.total} options against 60 on the page`);
    assert.equal(row.cap, 50);
  });
});

describe("rendered html", () => {
  it("captures the markup and hashes the whole document", async () => {
    const browser = await browsers.get();
    const context = await createContext(browser, browserConfig, { device: "desktop" });
    try {
      const page = await context.newPage();
      await page.goto(fixture.url("/overflow.html"), { waitUntil: "domcontentloaded" });

      const captured = await captureRenderedHtml(page, 8000);
      assert.equal(captured.captured, true, captured.note ?? "capture failed");

      // The digest is taken before any section is cut, so it identifies the
      // document rather than the part of it that survived the caps.
      const content = await page.content();
      const expected = createHash("sha256").update(content, "utf8").digest("hex");
      assert.equal(captured.sha256, expected, "the digest does not match the untruncated content");
      assert.equal(captured.bytes, Buffer.byteLength(content, "utf8"));
      assert.ok(captured.head.includes("<title>Overflow fixture</title>"), "the head was not carried");
      assert.ok(captured.body_skeleton, "the body skeleton is missing");
      assert.ok(
        captured.body_skeleton.includes("https://calendly.com/example/30min"),
        "the body skeleton lost an embed src",
      );
    } finally {
      await context.close();
    }
  });

  it("declines a document past the capture ceiling instead of reading it across", async () => {
    let contentCalls = 0;
    const enormous = {
      evaluate: () => Promise.resolve(String(9_000_000)),
      content: () => {
        contentCalls += 1;
        return Promise.resolve("<html><body>never read</body></html>");
      },
      waitForTimeout: () => Promise.resolve(),
    };

    const result = await captureRenderedHtml(enormous as never, 2000);
    assert.equal(result.captured, false, "a 9M-character document was pulled into the process");
    assert.equal(contentCalls, 0, "the markup was fetched after being measured as too large");
    assert.ok(result.note && result.note.includes("ceiling"), `unhelpful note: ${result.note}`);
  });

  it("reports a page.content() failure instead of throwing", async () => {
    let waited = false;
    const failing = {
      // measureDocument asks first; a page that will not evaluate is measured
      // as unknown and the capture proceeds exactly as it always did.
      evaluate: () => Promise.reject(new Error("execution context was destroyed")),
      content: () => Promise.reject(new Error("page is navigating and changing the content")),
      waitForTimeout: () => {
        waited = true;
        return Promise.resolve();
      },
    };

    // Losing the markup must never cost the caller an analysis that otherwise
    // succeeded, the same rule the screenshot step follows.
    const result = await captureRenderedHtml(failing as never, 1000);
    assert.equal(result.captured, false);
    assert.equal(result.sha256, null);
    assert.equal(result.head, "");
    assert.ok(result.note && result.note.includes("not captured"), `unhelpful note: ${result.note}`);
    assert.equal(waited, true, "the retry did not wait for the navigation to settle");
  });
});

describe("capture_profile: light", () => {
  it("checks no links", () => {
    assert.ok(overflow.links.total > 0, "the fixture has no links, so this proves nothing");
    assert.deepEqual(light.links.checked, [], "a light run checked links");
    assert.equal(light.links.check_summary.checked, 0);
  });

  it("skips the mobile viewport pass", () => {
    assert.equal(light.technical.mobile.tested, false, "a light run ran the mobile pass");
  });

  it("photographs at most three strips", () => {
    assert.equal(light.screenshot?.captured, true, "the light run captured no screenshot");
    assert.ok(
      (light.screenshot?.strips.length ?? 0) <= 3,
      `a light run took ${light.screenshot?.strips.length} strips`,
    );
    assert.equal(light.screenshot?.truncated, true, "a 9000px page cut to three strips is truncated");
    // The full profile is what proves the cap is the profile's doing and not
    // the page being short.
    assert.ok(
      (overflow.screenshot?.strips.length ?? 0) > 3,
      `the full run only took ${overflow.screenshot?.strips.length} strips`,
    );
  });

  it("still collects the same evidence", () => {
    assert.equal(light.raw_evidence.html.captured, true);
    assert.equal(light.raw_evidence.meta.truncated, true);
    assert.equal(light.raw_evidence.forms.length, overflow.raw_evidence.forms.length);
  });
});
