import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RunStore } from "../src/output/run_store.js";
import { analyzePage } from "../src/analysis/page_analyzer.js";
import { buildDataset } from "../src/analysis/funnel_summary.js";
import { metadata, pageRecord } from "./helpers/records.js";

const root = mkdtempSync(join(tmpdir(), "funnel-store-"));

after(() => rmSync(root, { recursive: true, force: true }));

describe("run store", () => {
  const meta = metadata();
  const store = new RunStore(root, meta.run_id, meta.funnel_id);
  const landing = analyzePage({ record: pageRecord(), role: "landing", sequence: 1, metadata: meta });

  it("keeps every run in its own directory", () => {
    assert.equal(store.dir, join(root, meta.run_id));
    assert.ok(existsSync(store.screenshotDir));

    const other = new RunStore(root, "other-funnel_2026-01-01_1300", "other-funnel");
    assert.notEqual(other.dir, store.dir);
  });

  it("writes predictable artifact names", () => {
    store.saveLandingPage(landing);
    store.savePage(landing);
    store.saveIssues({
      run_id: meta.run_id,
      funnel_id: meta.funnel_id,
      generated_at: new Date().toISOString(),
      total: landing.detected_issues.length,
      by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      issues: landing.detected_issues,
      recommendations: landing.recommendations,
    });

    assert.ok(existsSync(join(store.dir, "landing_page.json")));
    assert.ok(existsSync(join(store.dir, "issues.json")));
    assert.ok(existsSync(join(store.dir, "pages", "001_landing_optin.json")));

    const written = JSON.parse(readFileSync(join(store.dir, "landing_page.json"), "utf8"));
    assert.equal(written.funnel_metadata.run_id, meta.run_id);
    assert.equal(written.page_information.page_role, "landing");
  });

  it("always writes confirmation_page.json, even when the funnel has no booking", () => {
    store.saveConfirmationPage(null, "the funnel exposes no form or scheduling step");
    const file = JSON.parse(readFileSync(join(store.dir, "confirmation_page.json"), "utf8"));
    assert.equal(file.reached, false);
    assert.equal(file.funnel_id, meta.funnel_id);
    assert.match(file.reason, /no form or scheduling step/);
  });

  it("leaves no temp files behind and overwrites in place", () => {
    store.saveLandingPage(landing);
    assert.equal(existsSync(join(store.dir, "landing_page.json.tmp")), false);
  });

  it("builds a dataset a downstream system can read without the raw report", () => {
    const dataset = buildDataset({
      metadata: meta,
      run: {
        run_id: meta.run_id,
        state: "TASK_COMPLETED",
        status: "complete",
        started_at: meta.captured_at,
        finished_at: new Date().toISOString(),
        milestones: {
          landing_analyzed: true,
          form_located: false,
          form_submitted: false,
          scheduling_detected: false,
          booking_confirmed: false,
          confirmation_analyzed: false,
        },
        manual_gates: [],
      },
      funnel_path: [{ step: 1, url: meta.funnel_url, page_type: "optin", label: "Opt-in" }],
      landing,
      confirmation: null,
      intermediate: [],
      scheduling: { detected: false, provider: null, booked: false },
      confirmation_reason: "the funnel exposes no form or scheduling step",
      blocked: false,
      errors: 0,
      limitations: [],
    });

    store.saveAnalysis(dataset);
    const file = JSON.parse(readFileSync(join(store.dir, "analysis.json"), "utf8"));
    assert.equal(file.funnel_metadata.funnel_id, meta.funnel_id);
    assert.equal(file.data_quality.confirmation_page_captured, false);
    assert.equal(file.scheduling.detected, false);
    assert.ok(Array.isArray(file.issues));
    assert.ok(file.offer_summary.headline);
  });
});
