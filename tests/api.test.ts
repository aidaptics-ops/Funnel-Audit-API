import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/api/server.js";
import { loadApiConfig, type ApiConfig } from "../src/api/config.js";
import { isAllowedUrl } from "../src/api/url_guard.js";
import { BrowserManager } from "../src/browser/browser_manager.js";
import { analyzeLandingPage } from "../src/pipeline/analyze_landing.js";
import type { BrowserConfig } from "../src/types/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture_server.js";

const workDir = mkdtempSync(join(tmpdir(), "analyzer-api-"));

const browserConfig: BrowserConfig = {
  headless: true,
  device: "desktop",
  timeout_ms: 20000,
  navigation_timeout_ms: 25000,
  browser_channel: "chrome",
};

let fixture: FixtureServer;
let browsers: BrowserManager;
let server: Server;
let apiBase = "";
let config: ApiConfig;

async function post(path: string, body: unknown, raw?: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

before(async () => {
  fixture = await startFixtureServer();
  browsers = new BrowserManager(browserConfig);

  config = {
    ...loadApiConfig({} as NodeJS.ProcessEnv),
    port: 0,
    host: "127.0.0.1",
    allowPrivateHosts: true,
    checkMobileViewport: false,
    maxConcurrentAnalyses: 2,
    totalAnalysisTimeoutMs: 60000,
  };

  server = createServer(config, {
    analyze: async (url, jobId) => {
      const browser = await browsers.get();
      return analyzeLandingPage({
        url,
        jobId,
        browser,
        config: browserConfig,
        checkMobileViewport: false,
        linkCheck: {
          enabled: false,
          maxLinks: 0,
          timeoutMs: 2000,
          concurrency: 2,
          sameOriginOnly: true,
          isAllowedUrl: (candidate) => isAllowedUrl(candidate, { allowPrivateHosts: true }),
        },
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  apiBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await browsers?.close();
  await fixture?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("GET /health", () => {
  it("reports ok without touching the browser", async () => {
    const response = await fetch(`${apiBase}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime_s, "number");
    assert.equal(body.active_analyses, 0);
  });

  it("answers while an analysis is running", async () => {
    const analysis = post("/analyze", { url: fixture.url("/vsl.html") });
    const health = await fetch(`${apiBase}/health`).then((response) => response.json());
    assert.equal(health.status, "ok");
    const result = await analysis;
    assert.equal(result.status, 200);
  });
});

describe("POST /analyze", () => {
  it("returns the documented envelope", async () => {
    const { status, json } = await post("/analyze", { url: fixture.url("/optin.html") });
    assert.equal(status, 200);
    assert.equal(json.status, "completed");
    assert.ok(json.job_id);
    assert.equal(json.url, fixture.url("/optin.html"));
    assert.ok(json.analysis);
    assert.ok(json.analysis.funnel && json.analysis.page && json.analysis.observed_issues);
    assert.equal("predicted_issues" in json.analysis, false);
  });

  it("ships the raw evidence alongside the judged sections", async () => {
    const { json } = await post("/analyze", { url: fixture.url("/optin.html") });
    const evidence = json.analysis.raw_evidence;
    assert.ok(evidence, "raw_evidence is missing from the response");
    assert.equal(evidence.html.captured, true);
    assert.equal(typeof evidence.html.sha256, "string");
    assert.ok(Array.isArray(evidence.completeness) && evidence.completeness.length > 0);
    // The judged `forms` section filters; this one must not.
    assert.ok(evidence.forms.length >= json.analysis.forms.length);
  });

  it("reads capture_profile and never fails on an unrecognised one", async () => {
    const seen: string[] = [];
    const spy = createServer(config, {
      analyze: async (_url, _jobId, _budget, request) => {
        seen.push(request.captureProfile);
        return { schema_version: "test" } as any;
      },
    });
    await new Promise<void>((resolve) => spy.listen(0, "127.0.0.1", () => resolve()));
    const address = spy.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    try {
      for (const body of [
        { url: "https://example.com" },
        { url: "https://example.com", capture_profile: "light" },
        { url: "https://example.com", capture_profile: "full" },
        // A typo, a wrong type and a null must all degrade to the full audit
        // rather than costing the caller their analysis.
        { url: "https://example.com", capture_profile: "lite" },
        { url: "https://example.com", capture_profile: 7 },
        { url: "https://example.com", capture_profile: null },
      ]) {
        const response = await fetch(`${base}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200, `${JSON.stringify(body)} -> ${response.status}`);
        await response.text();
      }
    } finally {
      await new Promise<void>((resolve) => spy.close(() => resolve()));
    }

    assert.deepEqual(seen, ["full", "light", "full", "full", "full", "full"]);
  });

  it("handles repeated sequential analyses", async () => {
    for (const path of ["/optin.html", "/minimal.html", "/optin.html"]) {
      const { status, json } = await post("/analyze", { url: fixture.url(path) });
      assert.equal(status, 200, `${path} -> ${JSON.stringify(json).slice(0, 200)}`);
      assert.equal(json.status, "completed");
    }
    assert.equal(browsers.connected, true, "the browser survives repeated analyses");
  });

  it("rejects an invalid or missing URL", async () => {
    for (const body of [{}, { url: "" }, { url: "not-a-url" }, { url: 42 }]) {
      const { status, json } = await post("/analyze", body);
      assert.equal(status, 400, `${JSON.stringify(body)} -> ${status}`);
      assert.equal(json.status, "failed");
      assert.ok(json.error.code);
    }
  });

  it("rejects malformed JSON bodies", async () => {
    const { status, json } = await post("/analyze", null, "{not json");
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_body");
  });

  it("rejects unsupported schemes and private hosts even when asked nicely", async () => {
    const strict = createServer(
      { ...config, allowPrivateHosts: false },
      { analyze: async () => assert.fail("analyze must not run for a blocked URL") },
    );
    await new Promise<void>((resolve) => strict.listen(0, "127.0.0.1", () => resolve()));
    const address = strict.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    try {
      for (const [url, code] of [
        ["file:///etc/passwd", "unsupported_scheme"],
        ["http://169.254.169.254/latest/meta-data/", "private_host"],
        ["http://localhost:3000/admin", "private_host"],
        ["http://10.0.0.1/", "private_host"],
      ]) {
        const response = await fetch(`${base}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const json = await response.json();
        assert.equal(response.status, 400, `${url} -> ${response.status}`);
        assert.equal(json.error.code, code, `${url} -> ${json.error.code}`);
      }
    } finally {
      await new Promise<void>((resolve) => strict.close(() => resolve()));
    }
  });

  it("reports a navigation failure without leaking internals", async () => {
    const { status, json } = await post("/analyze", { url: "http://127.0.0.1:1/nothing-here" });
    assert.ok(status >= 400, `expected an error status, got ${status}`);
    assert.equal(json.status, "failed");
    assert.ok(json.error.code);
    const serialised = JSON.stringify(json);
    assert.doesNotMatch(serialised, /at .*\.ts:\d+|node_modules|[A-Za-z]:\\\\/, "no stack traces or paths");
  });
});

describe("routing", () => {
  it("404s unknown routes with the failure envelope", async () => {
    const response = await fetch(`${apiBase}/nope`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.status, "failed");
    assert.equal(body.error.code, "not_found");
  });

  it("answers CORS preflight", async () => {
    const response = await fetch(`${apiBase}/analyze`, { method: "OPTIONS" });
    assert.ok(response.status === 204 || response.status === 200);
    assert.ok(response.headers.get("access-control-allow-origin"));
  });

});

describe("cleanup", () => {
  it("closes every browser context it opens", async () => {
    const browser = await browsers.get();
    const before = browser.contexts().length;

    await post("/analyze", { url: fixture.url("/optin.html") });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(
      browser.contexts().length,
      before,
      `contexts leaked: ${before} -> ${browser.contexts().length}`,
    );
  });

  it("survives an analysis that throws", async () => {
    const failing = createServer(config, {
      analyze: async () => {
        throw new Error("boom with /secret/path detail");
      },
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", () => resolve()));
    const address = failing.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    try {
      const response = await fetch(`${base}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const json = await response.json();
      assert.equal(response.status, 500);
      assert.equal(json.error.code, "internal_error");
      assert.doesNotMatch(JSON.stringify(json), /secret\/path/, "internal detail must not leak");

      const health = await fetch(`${base}/health`).then((r) => r.json());
      assert.equal(health.status, "ok", "the server stays healthy after a failure");
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });
});

describe("job ids", () => {
  it("issues a distinct id per request", async () => {
    const first = await post("/analyze", { url: fixture.url("/optin.html") });
    const second = await post("/analyze", { url: fixture.url("/optin.html") });
    assert.notEqual(first.json.job_id, second.json.job_id);
    assert.notEqual(first.json.job_id, randomUUID());
  });
});
