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

/** Every key the API promises. A frontend and a downstream AI depend on these. */
const REQUIRED_KEYS = [
  "schema_version",
  "analyzed_at",
  "duration_ms",
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
  "summary",
  "observed_issues",
  // Always present, null unless the request asked for it. A key that only
  // sometimes exists is a worse contract than one that is explicitly empty.
  "screenshot",
] as const;

const workDir = mkdtempSync(join(tmpdir(), "analyzer-contract-"));

const browserConfig: BrowserConfig = {
  headless: true,
  device: "desktop",
  timeout_ms: 20000,
  navigation_timeout_ms: 25000,
  browser_channel: "chrome",
};

let fixture: FixtureServer;
let browsers: BrowserManager;
let analysis: LandingAnalysis;

before(async () => {
  fixture = await startFixtureServer();
  browsers = new BrowserManager(browserConfig);
  const browser = await browsers.get();
  analysis = await analyzeLandingPage({
    url: fixture.url("/vsl.html"),
    jobId: randomUUID(),
    browser,
    config: browserConfig,
    checkMobileViewport: false,
    linkCheck: {
      enabled: true,
      maxLinks: 10,
      timeoutMs: 4000,
      concurrency: 4,
      sameOriginOnly: true,
      isAllowedUrl: (url) => isAllowedUrl(url, { allowPrivateHosts: true }),
    },
    isAllowedUrl: (url) => isAllowedUrl(url, { allowPrivateHosts: true }),
  });
});

after(async () => {
  await browsers?.close();
  await fixture?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("response contract", () => {
  it("always carries every declared section", () => {
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in analysis, `missing top-level key: ${key}`);
      assert.notEqual(
        (analysis as unknown as Record<string, unknown>)[key],
        undefined,
        `${key} is undefined`,
      );
    }
  });

  it("carries no key the schema does not declare", () => {
    const extra = Object.keys(analysis).filter((key) => !(REQUIRED_KEYS as readonly string[]).includes(key));
    assert.deepEqual(extra, [], `undeclared keys: ${extra.join(", ")}`);
    assert.equal("predicted_issues" in analysis, false);
  });

  it("survives a JSON round trip without losing anything", () => {
    const roundTripped = JSON.parse(JSON.stringify(analysis));
    const lost = findLostPaths(analysis, roundTripped);
    assert.deepEqual(lost, [], `values lost or corrupted by JSON: ${lost.slice(0, 10).join(", ")}`);
  });

  it("contains no undefined, NaN or non-JSON value anywhere", () => {
    const bad = findNonJsonValues(analysis);
    assert.deepEqual(bad, [], `non-JSON values: ${bad.slice(0, 10).join(", ")}`);
  });

  it("never leaks an absolute filesystem path", () => {
    const serialised = JSON.stringify(analysis);
    assert.doesNotMatch(serialised, /[A-Za-z]:\\\\/, "a Windows absolute path leaked");
    assert.doesNotMatch(serialised, /"\/(?:home|root|Users|var|etc|tmp)\//, "a POSIX absolute path leaked");
  });

  it("states plainly that no form was interacted with", () => {
    for (const form of analysis.forms) {
      assert.equal(form.interacted, false, `form ${form.form_id ?? form.index} claims interaction`);
    }
  });

  it("keeps every determination either evidenced or explicitly unknown", () => {
    const determinations = [
      ["funnel.funnel_type", analysis.funnel.funnel_type],
      ["funnel.brand_name", analysis.funnel.brand_name],
      ["funnel.primary_conversion_goal", analysis.funnel.primary_conversion_goal],
      ["hero.value_proposition", analysis.hero.value_proposition],
      ["vsl.determination", analysis.vsl.determination],
      ["offer.product", analysis.offer.product],
      ["offer.audience", analysis.offer.audience],
      ["offer.mechanism", analysis.offer.mechanism],
      ["offer.risk_reversal", analysis.offer.risk_reversal],
      ["offer.clarity", analysis.offer.clarity],
    ] as const;

    for (const [name, determination] of determinations) {
      if (determination.status === "detected") {
        assert.ok(determination.evidence.length > 0, `${name} is detected with no evidence`);
        assert.ok(
          determination.confidence > 0 && determination.confidence <= 0.95,
          `${name} has an implausible confidence: ${determination.confidence}`,
        );
      } else {
        assert.ok(determination.reason.length > 0, `${name} is unknown with no reason`);
      }
    }
  });

  it("keeps the payload a sane size", () => {
    const bytes = Buffer.byteLength(JSON.stringify(analysis));
    assert.ok(bytes < 2_000_000, `response is ${bytes} bytes, which is too large for one landing page`);
  });
});

/** Paths present in the original that JSON.stringify dropped or changed shape. */
function findLostPaths(original: unknown, roundTripped: unknown, path = "$"): string[] {
  if (original === null || typeof original !== "object") {
    return Object.is(original, roundTripped) ? [] : [path];
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(roundTripped) || original.length !== roundTripped.length) return [path];
    return original.flatMap((item, index) => findLostPaths(item, roundTripped[index], `${path}[${index}]`));
  }

  const source = original as Record<string, unknown>;
  const target = (roundTripped ?? {}) as Record<string, unknown>;
  const lost: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue; // reported by findNonJsonValues instead
    if (!(key in target)) {
      lost.push(`${path}.${key}`);
      continue;
    }
    lost.push(...findLostPaths(value, target[key], `${path}.${key}`));
  }
  return lost;
}

function findNonJsonValues(value: unknown, path = "$"): string[] {
  if (value === undefined) return [`${path} (undefined)`];
  if (typeof value === "number" && !Number.isFinite(value)) return [`${path} (${value})`];
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return [`${path} (${typeof value})`];
  }
  if (value === null || typeof value !== "object") return [];
  if (value instanceof Map || value instanceof Set) return [`${path} (${value.constructor.name})`];
  if (Buffer.isBuffer(value)) return [`${path} (Buffer)`];
  if (value instanceof Date) return [`${path} (Date)`];
  if (Array.isArray(value)) return value.flatMap((item, index) => findNonJsonValues(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    findNonJsonValues(item, `${path}.${key}`),
  );
}
