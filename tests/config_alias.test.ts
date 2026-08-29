import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadApiConfig } from "../src/api/config.js";

describe("headless configuration", () => {
  it("defaults to headless", () => {
    assert.equal(loadApiConfig({} as NodeJS.ProcessEnv).headless, true);
  });

  it("still honours the original FUNNEL_HEADLESS variable", () => {
    assert.equal(loadApiConfig({ FUNNEL_HEADLESS: "false" } as NodeJS.ProcessEnv).headless, false);
  });

  it("lets HEADLESS win when both are set", () => {
    const config = loadApiConfig({ HEADLESS: "true", FUNNEL_HEADLESS: "false" } as NodeJS.ProcessEnv);
    assert.equal(config.headless, true);
  });
});
