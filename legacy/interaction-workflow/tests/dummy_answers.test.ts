import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dummyNumber, dummyText, pickRandom, prepareIdentity, uniqueEmail, usablePhone } from "../src/crawler/dummy_answers.js";

describe("dummy answers", () => {
  it("builds a unique valid email from the base address", () => {
    const first = uniqueEmail("test@example.com");
    const second = uniqueEmail("test@example.com");
    assert.match(first, /^test\+[a-z0-9]+@example\.com$/);
    assert.notEqual(first, second);
  });

  it("keeps a real 10-digit phone and replaces all-zero placeholders", () => {
    assert.equal(usablePhone("+15551234567"), "5551234567");
    assert.equal(usablePhone("+10000000000"), "2024567890");
  });

  it("picks different options over many draws", () => {
    const pool = ["A", "B", "C", "D"];
    const seen = new Set(Array.from({ length: 40 }, () => pickRandom(pool)));
    assert.ok(seen.size > 1);
  });

  it("returns occupation-like text rather than asdfgh", () => {
    const text = dummyText("Current occupation", "textarea");
    assert.ok(text.length > 4);
    assert.doesNotMatch(text, /asdf/i);
  });

  it("returns a numeric hours answer", () => {
    const hours = Number(dummyNumber("Estimated hours worked per week"));
    assert.ok(hours >= 25 && hours < 50);
  });

  it("prepares a complete test identity", () => {
    const identity = prepareIdentity({
      first_name: "Jim",
      last_name: "Corbi",
      email: "test@example.com",
      phone: "+10000000000",
    });
    assert.equal(identity.first_name, "Jim");
    assert.match(identity.email || "", /@/);
    assert.equal(identity.phone, "2024567890");
  });
});
