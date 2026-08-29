import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeCrawlId, siteSlugFromUrl } from "../src/output/crawl_id.js";

describe("crawl output names", () => {
  it("uses the site and page path instead of a UUID", () => {
    assert.equal(
      siteSlugFromUrl("https://hacker-fit.org/the-hackerfit-system?fbclid=abc"),
      "hacker-fit-org_the-hackerfit-system",
    );
    assert.equal(siteSlugFromUrl("https://example.com/"), "example-com");
  });

  it("includes a date-time stamp", () => {
    const id = makeCrawlId("https://hacker-fit.org/the-hackerfit-system", new Date("2026-08-26T14:22:00"));
    assert.match(id, /^hacker-fit-org_the-hackerfit-system_\d{4}-\d{2}-\d{2}_\d{4}$/);
  });
});
