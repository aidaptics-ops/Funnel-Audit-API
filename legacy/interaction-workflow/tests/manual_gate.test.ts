import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TERMINAL_TEXT, newMatch } from "../src/crawler/manual_gate.js";
import { PROGRESS_TEXT, isTerminalText } from "../src/crawler/embed_completion.js";
import { EmbedEventBus } from "../src/crawler/embed_events.js";
import {
  BOOKED_TEXT,
  CALENDLY_BLOCKED_TEXT,
  CALENDLY_BOOKED_URL,
  SCHEDULING_TEXT,
} from "../src/crawler/scheduling_detector.js";
import { schedulerProvider } from "../src/extraction/embed_hosts.js";

describe("manual gate completion signals", () => {
  it("fires on a thank-you phrase that was not on screen before", () => {
    assert.equal(
      newMatch(TERMINAL_TEXT, "Thank you! We'll be in touch shortly.", "Apply now to get started"),
      true,
    );
  });

  it("does not fire on wording that was already on the page", () => {
    const before = "Thank you for reading. Apply below.";
    assert.equal(newMatch(TERMINAL_TEXT, `${before} Apply below.`, before), false);
  });

  it("recognises genuine post-submit screens", () => {
    for (const text of [
      "Your application was received",
      "You're all set",
      "Form submitted",
      "Your response has been recorded",
      "Thanks! We'll be in touch",
    ]) {
      assert.equal(TERMINAL_TEXT.test(text), true, `expected a completion match for: ${text}`);
    }
  });

  // Regression: a Typeform showing "Next step" was reported as submitted, so
  // the run skipped the rest of the form and never reached the scheduler.
  it("never treats multi-step progress chrome as completion", () => {
    for (const text of [
      "Next step",
      "Next step: tell us about your business",
      "Continue",
      "Next question",
      "Proceed",
      "Almost done",
      "Step 3 of 7",
      "4 of 9 questions",
      "Press Enter ↵",
      "Powered by Typeform",
    ]) {
      assert.equal(TERMINAL_TEXT.test(text), false, `"${text}" must not count as completion`);
      assert.equal(isTerminalText(text), false, `"${text}" must not count as completion`);
      assert.equal(PROGRESS_TEXT.test(text), true, `"${text}" should be recognised as progress chrome`);
    }
  });

  it("keeps completion wording that merely sits next to progress wording", () => {
    // The phrase itself is terminal; nearby progress chrome is irrelevant.
    assert.equal(isTerminalText("Thank you! Your application was received."), true);
  });
});

describe("booking signals", () => {
  it("detects a Calendly invitee URL", () => {
    assert.equal(
      CALENDLY_BOOKED_URL.test("https://calendly.com/acme/30min/invitees/abc-123"),
      true,
    );
    assert.equal(CALENDLY_BOOKED_URL.test("https://calendly.com/acme/30min"), false);
  });

  it("detects confirmation wording", () => {
    assert.equal(BOOKED_TEXT.test("You are scheduled with Jane Doe"), true);
    assert.equal(BOOKED_TEXT.test("Your appointment is confirmed"), true);
    assert.equal(BOOKED_TEXT.test("Select a Day"), false);
  });

  it("recognises Calendly's automation refusal separately from a booking", () => {
    const refusal =
      "This booking cannot be completed. For security reasons, we are not able to finalize this booking from your current session.";
    assert.equal(CALENDLY_BLOCKED_TEXT.test(refusal), true);
    assert.equal(BOOKED_TEXT.test(refusal), false);
  });

  it("recognises scheduling surfaces before a booking happens", () => {
    assert.equal(SCHEDULING_TEXT.test("Select a Date & Time"), true);
    assert.equal(SCHEDULING_TEXT.test("Time zone: Eastern Time"), true);
    // CTA copy is not a scheduler on screen.
    assert.equal(SCHEDULING_TEXT.test("Book a call with our team"), false);
    assert.equal(SCHEDULING_TEXT.test("Schedule your free strategy session"), false);
    assert.equal(schedulerProvider("https://calendly.com/acme/30min"), "calendly");
    assert.equal(schedulerProvider("https://api.leadconnectorhq.com/widget/booking/xyz"), "gohighlevel_calendar");
    assert.equal(schedulerProvider("https://form.typeform.com/to/abc"), null);
  });
});

describe("embed event bus", () => {
  it("only reports events recorded after the mark", () => {
    const bus = new EmbedEventBus();
    bus.record({ name: "calendly.date_and_time_selected", payload: null, origin: null, frame_url: null });
    const mark = bus.length;
    assert.equal(bus.findSince(mark, /^calendly\.event_scheduled$/), null);
    bus.record({ name: "calendly.event_scheduled", payload: { uri: "x" }, origin: "https://calendly.com", frame_url: null });
    assert.equal(bus.findSince(mark, /^calendly\.event_scheduled$/)?.origin, "https://calendly.com");
  });
});
