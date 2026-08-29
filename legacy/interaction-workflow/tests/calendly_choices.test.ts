import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCalendlyDeclineChoice, preferredCalendlyChoice } from "../src/crawler/calendly_choices.js";

describe("Calendly invitee radio choice", () => {
  const understand = "I understand, if anything changes, I'll let you know";
  const decline = "No, I don't intend to show up, please cancel the appointment";

  it("keeps the I understand option when both radios are present", () => {
    assert.equal(preferredCalendlyChoice([understand, decline]), understand);
    assert.equal(preferredCalendlyChoice([decline, understand]), understand);
  });

  it("never prefers the cancel / no-show option", () => {
    assert.equal(isCalendlyDeclineChoice(decline), true);
    assert.equal(isCalendlyDeclineChoice(understand), false);
    assert.equal(preferredCalendlyChoice([decline]), decline);
    assert.equal(preferredCalendlyChoice([decline, "Yes, I will be there"]), "Yes, I will be there");
  });
});
