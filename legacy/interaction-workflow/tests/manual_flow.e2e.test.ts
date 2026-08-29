import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { runWithConfig } from "../src/main.js";
import type { CrawlConfig, ManualGateKind } from "../src/types/index.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "funnel");
const outputDir = mkdtempSync(join(tmpdir(), "funnel-e2e-"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
};

let server: Server;
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
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(outputDir, { recursive: true, force: true });
});

function config(startUrl: string, overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  return {
    start_url: startUrl,
    max_pages: 6,
    headless: true,
    device: "desktop",
    submit_forms: false,
    submit_booking: false,
    submit_checkout: false,
    output_dir: outputDir,
    screenshot_dir: outputDir,
    timeout_ms: 15000,
    navigation_timeout_ms: 20000,
    manual_mode: true,
    manual_form_timeout_ms: 30000,
    manual_booking_timeout_ms: 30000,
    operator_prompt: false,
    ...overrides,
  };
}

function read(dir: string, name: string): any {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

/**
 * Stands in for the operator: fills and submits the form, then picks a slot.
 * The crawler never does this itself in manual mode, which is the point.
 */
function operator(log: string[]) {
  return {
    onGateOpen: async (page: Page, kind: ManualGateKind) => {
      log.push(kind);
      if (kind === "form_submission") {
        await page.fill("#name", "Ada Tester").catch(() => undefined);
        await page.fill("#email", "ada@example.com");
        await page.click("button[type=submit]");
        return;
      }
      await page.click("#slot");
    },
  };
}

describe("manual funnel run, end to end", () => {
  it("analyses the landing page, waits for the human, then analyses the confirmation page", async (t) => {
    t.diagnostic("a hook stands in for the operator: it fills, submits and books through the real browser");
    const acted: string[] = [];
    const result = await runWithConfig(config(`${base}/index.html`), operator(acted));
    assert.deepEqual(acted, ["form_submission", "booking_confirmation"]);

    assert.equal(result.code, 0);
    const manifest = read(result.dir, "manifest.json");
    assert.equal(manifest.state, "TASK_COMPLETED");
    assert.equal(manifest.mode, "manual");
    assert.equal(manifest.business_name, "Northwind Coaching");

    assert.deepEqual(manifest.milestones, {
      landing_analyzed: true,
      form_located: true,
      form_submitted: true,
      scheduling_detected: true,
      booking_confirmed: true,
      confirmation_analyzed: true,
    });

    const states = manifest.state_history.map((entry: any) => entry.to);
    assert.deepEqual(states, [
      "CRAWLING_LANDING_PAGE",
      "ANALYZING_LANDING_PAGE",
      "LOCATING_FORM",
      "WAITING_FOR_FORM_INPUT",
      "FORM_SUBMITTED",
      "WAITING_FOR_CALENDLY_BOOKING",
      "BOOKING_CONFIRMED",
      "ANALYZING_CONFIRMATION_PAGE",
      "TASK_COMPLETED",
    ]);

    // Both gates were released by a detected signal, not by a timer.
    assert.equal(manifest.manual_gates.length, 2);
    for (const gate of manifest.manual_gates) {
      assert.equal(gate.status, "detected", `${gate.kind} should be detected: ${gate.detail}`);
      assert.notEqual(gate.signal, "none");
    }

    const landing = read(result.dir, "landing_page.json");
    assert.equal(landing.page_information.page_role, "landing");
    assert.equal(landing.page_structure.key_copy.headline, "Get your free profit audit");
    assert.equal(landing.videos.count, 1);
    assert.equal(landing.videos.items[0].provider, "youtube");
    assert.equal(landing.forms.count, 1);
    assert.equal(landing.forms.items[0].field_count, 3);
    assert.equal(landing.forms.items[0].integration.embed_type, "native");
    assert.ok(landing.ctas.count >= 1);
    assert.equal(landing.tracking_technical.has_pixel, true);
    assert.equal(landing.navigation.nav_links, 3);
    assert.ok(landing.detected_issues.every((issue: any) => issue.evidence.length > 0));

    const confirmation = read(result.dir, "confirmation_page.json");
    assert.equal(confirmation.page_information.page_role, "confirmation");
    assert.match(confirmation.page_information.url, /thanks\.html$/);
    assert.equal(confirmation.confirmation_details.is_confirmation_page, true);
    assert.equal(confirmation.confirmation_details.appointment.detected, true);
    assert.equal(confirmation.confirmation_details.appointment.time_text, "10:30 am");
    assert.equal(confirmation.confirmation_details.appointment.timezone, "EST");
    assert.equal(confirmation.confirmation_details.appointment.meeting_link, "https://zoom.us/j/123456789");
    assert.equal(confirmation.confirmation_details.appointment.add_to_calendar_links.length, 1);
    assert.ok(confirmation.confirmation_details.next_steps.length >= 1);

    // Landing and confirmation share one schema.
    assert.deepEqual(Object.keys(landing).sort(), Object.keys(confirmation).sort());

    const analysis = read(result.dir, "analysis.json");
    assert.equal(analysis.scheduling.detected, true);
    assert.equal(analysis.scheduling.booked, true);
    assert.equal(analysis.data_quality.confirmation_page_captured, true);
    assert.ok(analysis.issues.length > 0);
    assert.ok(analysis.recommendations.length > 0);
    assert.ok(analysis.forms.length >= 1);

    const issues = read(result.dir, "issues.json");
    assert.equal(issues.total, analysis.issues.length);
    assert.equal(issues.run_id, manifest.run_id);

    for (const file of ["report.json", "forms.json", "events.json", "issues.json", "analysis.json"]) {
      assert.ok(existsSync(join(result.dir, file)), `${file} should exist`);
    }
    assert.ok(existsSync(join(result.dir, "screenshots")));
    assert.ok(existsSync(join(result.dir, "pages")));
  });

  it("finishes normally on a funnel with no scheduling step", async () => {
    const result = await runWithConfig(config(`${base}/no-scheduler.html`), operator([]));

    assert.equal(result.code, 0);
    const manifest = read(result.dir, "manifest.json");
    assert.equal(manifest.state, "TASK_COMPLETED");
    assert.equal(manifest.milestones.form_submitted, true);
    assert.equal(manifest.milestones.scheduling_detected, false);
    assert.equal(manifest.milestones.booking_confirmed, false);
    assert.equal(manifest.milestones.confirmation_analyzed, true);
    assert.equal(manifest.manual_gates.length, 1);
    assert.equal(
      manifest.state_history.some((entry: any) => entry.to === "WAITING_FOR_CALENDLY_BOOKING"),
      false,
    );

    const confirmation = read(result.dir, "confirmation_page.json");
    assert.match(confirmation.page_information.url, /thanks-simple\.html/);
    assert.equal(confirmation.confirmation_details.is_confirmation_page, true);
  });

  it("handles an embedded form whose scheduler sits between questions", async (t) => {
    t.diagnostic("Typeform-shaped embed: questions -> Calendly block -> more questions");
    const acted: string[] = [];
    const result = await runWithConfig(config(`${base}/embedded.html`), {
      onGateOpen: async (page: Page, kind: ManualGateKind) => {
        acted.push(kind);
        const form = page.frameLocator("#embed");
        if (acted.length === 1) {
          await form.locator("#name").fill("Ada Tester");
          await form.locator("#email").fill("ada@example.com");
          await form.locator("#ok-1").click();
          return;
        }
        if (kind === "booking_confirmation") {
          await form.frameLocator("#calendar").locator("#slot").click();
          return;
        }
        // Third gate: the questions that follow the booking.
        await form.locator("#notes").fill("Looking to fix my follow-up.");
        await form.locator("#submit").click();
      },
    });

    assert.equal(result.code, 0);
    assert.deepEqual(acted, ["form_submission", "booking_confirmation", "form_submission"]);

    const manifest = read(result.dir, "manifest.json");
    assert.equal(manifest.state, "TASK_COMPLETED");
    assert.equal(manifest.milestones.scheduling_detected, true);
    assert.equal(manifest.milestones.booking_confirmed, true);
    assert.equal(manifest.milestones.confirmation_analyzed, true);

    const [formGate, bookingGate, finishGate] = manifest.manual_gates;
    // Reaching the scheduler is progress inside the form, not a submission…
    assert.equal(formGate.signal, "scheduling_embed_appeared");
    // …the booking is reported by Calendly's own postMessage event…
    assert.equal(bookingGate.signal, "calendly_event_scheduled");
    // …and only the provider's submit event ends the form.
    assert.equal(finishGate.signal, "embed_form_submitted");
    assert.match(finishGate.detail, /form-submit|thank-you screen/i);

    // The form counts as submitted only after that last gate.
    assert.equal(manifest.milestones.form_submitted, true);
    const submittedAt = manifest.manual_gates.findIndex((g: any) => g.signal === "embed_form_submitted");
    assert.equal(submittedAt, 2, "the form is only submitted at the third gate");

    // One entry per funnel state, not one per capture of the same URL.
    const path = read(result.dir, "report.json").funnel_path;
    const labels = path.map((step: any) => step.label);
    assert.equal(new Set(labels).size, labels.length, `funnel path repeats a state: ${labels.join(" | ")}`);
    assert.match(labels[0], /^Landing page/);
    assert.match(labels[labels.length - 1], /^Confirmation/);
    assert.ok(path.every((step: any) => step.run_state && step.page_role));

    const landing = read(result.dir, "landing_page.json");
    assert.equal(landing.forms.items[0].integration.provider, "typeform");
    assert.equal(landing.forms.items[0].integration.embed_type, "iframe");

    // The confirmation lives inside the embed, where body text cannot reach.
    const confirmation = read(result.dir, "confirmation_page.json");
    assert.ok(confirmation.confirmation_details.evidence.some((line: string) => /embed .*typeform/i.test(line)));
    assert.match(confirmation.confirmation_details.confirmation_message ?? "", /scheduled|thank you/i);
    assert.equal(confirmation.confirmation_details.appointment.detected, true);
    // The embed reports the zone as either the abbreviation or the full name.
    assert.match(confirmation.confirmation_details.appointment.timezone ?? "", /EST|Eastern Time/);
    assert.match(confirmation.confirmation_details.appointment.date_text ?? "", /Mar/i);
  });

  it("keeps each run in its own directory", async () => {
    const first = await runWithConfig(config(`${base}/no-scheduler.html`), operator([]));
    const second = await runWithConfig(config(`${base}/no-scheduler.html`), operator([]));
    assert.notEqual(first.dir, second.dir);
    assert.notEqual(first.run_id, second.run_id);
    assert.equal(read(first.dir, "manifest.json").run_id, first.run_id);
    assert.equal(read(second.dir, "manifest.json").run_id, second.run_id);
  });

  it("times out cleanly and still writes artifacts when nobody fills the form", async () => {
    const result = await runWithConfig(
      config(`${base}/no-scheduler.html`, { manual_form_timeout_ms: 3000, manual_booking_timeout_ms: 3000 }),
    );

    const manifest = read(result.dir, "manifest.json");
    assert.equal(manifest.state, "TASK_COMPLETED");
    assert.equal(manifest.status, "partial");
    assert.equal(manifest.manual_gates[0].status, "timeout");
    assert.equal(manifest.milestones.form_submitted, false);
    assert.equal(manifest.milestones.confirmation_analyzed, false);
    assert.ok(existsSync(join(result.dir, "landing_page.json")));

    // The page we were left on is not passed off as a confirmation page.
    const confirmation = read(result.dir, "confirmation_page.json");
    assert.equal(confirmation.reached, false);
    assert.match(confirmation.reason, /never submitted/i);

    const analysis = read(result.dir, "analysis.json");
    assert.equal(analysis.confirmation_page, null);
    assert.equal(analysis.data_quality.confirmation_page_captured, false);
    assert.ok(analysis.data_quality.limitations.some((line: string) => /timed out/i.test(line)));
  });
});
