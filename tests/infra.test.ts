import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Semaphore, TimeoutError, withTimeout } from "../src/api/concurrency.js";
import { loadApiConfig } from "../src/api/config.js";

const workDir = mkdtempSync(join(tmpdir(), "analyzer-infra-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

describe("configuration", () => {
  it("falls back to defaults for missing and malformed values", () => {
    const config = loadApiConfig({ PORT: "not-a-number", MAX_CONCURRENT_ANALYSES: "-3" } as NodeJS.ProcessEnv);
    assert.equal(config.port, 3000);
    assert.equal(config.host, "0.0.0.0");
    assert.ok(config.maxConcurrentAnalyses >= 1);
    assert.equal(config.allowPrivateHosts, false);
  });

  it("reads the documented environment variables", () => {
    const config = loadApiConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      MAX_CONCURRENT_ANALYSES: "5",
      NAVIGATION_TIMEOUT_MS: "12000",
      ANALYSIS_TIMEOUT_MS: "45000",
      ALLOW_PRIVATE_HOSTS: "true",
      CHECK_LINKS: "false",
      CHECK_MOBILE_VIEWPORT: "false",
    } as NodeJS.ProcessEnv);
    assert.equal(config.port, 8080);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.maxConcurrentAnalyses, 5);
    assert.equal(config.navigationTimeoutMs, 12000);
    assert.equal(config.totalAnalysisTimeoutMs, 45000);
    assert.equal(config.allowPrivateHosts, true);
    assert.equal(config.checkLinks, false);
    assert.equal(config.checkMobileViewport, false);
  });
});

describe("concurrency", () => {
  it("caps parallel work at the limit", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await semaphore.acquire();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        release();
      }),
    );

    assert.equal(peak, 2);
    assert.equal(semaphore.active, 0);
    assert.equal(semaphore.queued, 0);
  });

  it("rejects with TimeoutError when the queue wait is exceeded", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    await assert.rejects(() => semaphore.acquire(30), TimeoutError);
    release();
  });

  it("ignores a double release", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    assert.equal(semaphore.active, 0);
    const second = await semaphore.acquire();
    second();
  });

  it("withTimeout rejects slow work and passes fast work through", async () => {
    assert.equal(await withTimeout(Promise.resolve("fast"), 50, "too slow"), "fast");
    await assert.rejects(
      () => withTimeout(new Promise((resolve) => setTimeout(resolve, 200)), 20, "too slow"),
      /too slow/,
    );
  });
});
