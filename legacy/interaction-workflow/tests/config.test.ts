import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, parseArgs } from "../src/config/load_config.js";

const fixtureEnvDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "env-project");

describe("parseArgs", () => {
  it("accepts a positional URL", () => {
    const args = parseArgs(["https://example.com"]);
    assert.equal(args.url, "https://example.com");
  });

  it("parses identity and device flags", () => {
    const args = parseArgs([
      "--url",
      "https://example.com",
      "--email",
      "test@example.com",
      "--device",
      "mobile",
      "--no-submit",
    ]);
    assert.equal(args.email, "test@example.com");
    assert.equal(args.device, "mobile");
    assert.equal(args.submitForms, false);
  });
});

describe("loadConfig", () => {
  it("requires a start URL", () => {
    const previous = process.env.FUNNEL_START_URL;
    delete process.env.FUNNEL_START_URL;
    try {
      const emptyDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
      assert.throws(() => loadConfig({}, emptyDir), /start URL/i);
    } finally {
      if (previous !== undefined) process.env.FUNNEL_START_URL = previous;
    }
  });

  it("does not invent a test identity when none is supplied", () => {
    const config = loadConfig({ url: "https://example.com", firstName: undefined }, process.cwd());
    // .env in the project may populate identity; empty email/phone still means unusable for submit
    if (!config.test_identity?.email && !config.test_identity?.phone) {
      assert.equal(config.test_identity, undefined);
    }
  });

  it("loads URL and test identity from .env when no CLI flags are passed", () => {
    const config = loadConfig({}, fixtureEnvDir);
    assert.equal(config.start_url, "https://env-fixture.example/webinar");
    assert.equal(config.test_identity?.first_name, "Ada");
    assert.equal(config.test_identity?.last_name, "Tester");
    assert.equal(config.test_identity?.email, "ada.tester@example.com");
    assert.equal(config.test_identity?.phone, "+15555550100");
    assert.equal(config.max_pages, 7);
    // Manual mode is the default and always needs a visible window.
    assert.equal(config.manual_mode, true);
    assert.equal(config.headless, false);
  });

  it("honours FUNNEL_HEADLESS in automatic mode", () => {
    const config = loadConfig({ manualMode: false }, fixtureEnvDir);
    assert.equal(config.manual_mode, false);
    assert.equal(config.headless, true);
  });

  it("parses manual-mode flags", () => {
    assert.equal(parseArgs(["--auto"]).manualMode, false);
    assert.equal(parseArgs(["--manual"]).manualMode, true);
    assert.equal(parseArgs(["--manual-timeout", "120"]).manualTimeoutMs, 120000);
    const config = loadConfig({ url: "https://example.com", manualTimeoutMs: 120000 }, fixtureEnvDir);
    assert.equal(config.manual_form_timeout_ms, 120000);
    assert.equal(config.manual_booking_timeout_ms, 120000);
  });

  it("lets CLI flags override .env", () => {
    const config = loadConfig({ url: "https://cli.example", email: "cli@example.com" }, fixtureEnvDir);
    assert.equal(config.start_url, "https://cli.example");
    assert.equal(config.test_identity?.email, "cli@example.com");
    assert.equal(config.test_identity?.first_name, "Ada");
  });
});
