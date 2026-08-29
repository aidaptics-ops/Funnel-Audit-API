import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { EmbedEventBus } from "../src/crawler/embed_events.js";
import { readEmbeddedFormStatus } from "../src/crawler/embed_completion.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "funnel");

let server: Server;
let browser: Browser;
let page: Page;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const file = join(fixtureDir, path === "/" ? "index.html" : path.replace(/^\//, ""));
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>not found</h1>");
      return;
    }
    res.writeHead(200, {
      "content-type": extname(file) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";

  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("embedded form completion state", () => {
  it("reports in_progress while a Typeform is still asking questions", async () => {
    await page.goto(`${base}/embedded.html`, { waitUntil: "networkidle" });
    const status = await readEmbeddedFormStatus(page);
    assert.equal(status.present, true);
    assert.equal(status.provider, "typeform");
    assert.equal(status.state, "in_progress");
  });

  // The exact real-funnel failure: a "Next step" button inside an open Typeform
  // was read as a submitted form.
  it("stays in_progress when the form shows a Next step control", async () => {
    await page.goto(`${base}/embedded.html`, { waitUntil: "networkidle" });
    await page.frameLocator("#embed").locator("#show-next-step").click();

    const frameText = await page.frameLocator("#embed").locator("body").innerText();
    assert.match(frameText, /Next step/i, "fixture must show the phrase that caused the false positive");

    const status = await readEmbeddedFormStatus(page);
    assert.equal(status.state, "in_progress");
    assert.match(status.evidence, /question element/i);
  });

  it("reports completed once the thank-you screen replaces the questions", async () => {
    await page.goto(`${base}/embedded.html`, { waitUntil: "networkidle" });
    const form = page.frameLocator("#embed");
    await form.locator("#name").fill("Ada Tester");
    await form.locator("#email").fill("ada@example.com");
    await form.locator("#ok-1").click();
    await form.frameLocator("#calendar").locator("#slot").click();
    await form.locator("#notes").fill("done");
    await form.locator("#submit").click();

    const status = await readEmbeddedFormStatus(page);
    assert.equal(status.state, "completed");
    assert.match(status.evidence, /thank-you screen|no question left/i);
  });

  it("trusts a provider submit event over the DOM", async () => {
    await page.goto(`${base}/embedded.html`, { waitUntil: "networkidle" });
    const events = new EmbedEventBus();
    const mark = events.length;
    events.record({
      name: "typeform.form-submit",
      payload: { formId: "abc", responseId: "xyz" },
      origin: "https://form.typeform.com",
      frame_url: `${base}/typeform.com/form.html`,
    });

    const status = await readEmbeddedFormStatus(page, { events, sinceEventIndex: mark });
    assert.equal(status.state, "completed");
    assert.match(status.evidence, /posted typeform\.form-submit/);
  });

  it("ignores provider events recorded before the wait began", async () => {
    await page.goto(`${base}/embedded.html`, { waitUntil: "networkidle" });
    const events = new EmbedEventBus();
    events.record({ name: "typeform.form-submit", payload: null, origin: null, frame_url: null });
    const mark = events.length; // the gate opens after that stale event

    const status = await readEmbeddedFormStatus(page, { events, sinceEventIndex: mark });
    assert.equal(status.state, "in_progress");
  });

  it("reports absent when the page has no embedded form", async () => {
    await page.goto(`${base}/no-scheduler.html`, { waitUntil: "networkidle" });
    const status = await readEmbeddedFormStatus(page);
    assert.equal(status.present, false);
    assert.equal(status.state, "absent");
  });
});
