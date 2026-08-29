import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferFieldPurpose } from "../src/extraction/field_purpose.js";

describe("inferFieldPurpose", () => {
  it("maps email fields", () => {
    assert.equal(inferFieldPurpose({ type: "email" }), "email");
    assert.equal(inferFieldPurpose({ name: "email_address" }), "email");
    assert.equal(inferFieldPurpose({ autocomplete: "email", type: "text" }), "email");
  });

  it("maps name and phone fields", () => {
    assert.equal(inferFieldPurpose({ name: "first_name" }), "first_name");
    assert.equal(inferFieldPurpose({ name: "lname" }), "last_name");
    assert.equal(inferFieldPurpose({ type: "tel" }), "phone");
    assert.equal(inferFieldPurpose({ label: "Your Name" }), "full_name");
  });

  it("maps consent, password, and payment", () => {
    assert.equal(inferFieldPurpose({ type: "checkbox", label: "I agree to the terms" }), "consent");
    assert.equal(inferFieldPurpose({ type: "password" }), "password");
    assert.equal(inferFieldPurpose({ name: "cc-number", autocomplete: "cc-number" }), "payment");
  });

  it("does not invent a purpose for unknown questions", () => {
    assert.equal(inferFieldPurpose({ label: "What is your current monthly revenue?" }), "other");
  });
});
