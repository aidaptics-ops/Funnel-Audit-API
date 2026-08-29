import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isHashOnlyChange, isSameDocument } from "../src/pipeline/page_stability.js";
import { isFormEmbedSrc } from "../src/extraction/embed_hosts.js";
import { isProblemStatement } from "../src/extraction/testimonial_detector.js";
import { detectObjections } from "../src/extraction/conversion_detector.js";
import { fieldsFromUnknown } from "../src/extraction/embedded_form_inspector.js";

describe("hash-only navigation", () => {
  const base =
    "https://hacker-fit.org/the-hackerfit-system?sid=1";
  it("does not treat a hash change as a new document", () => {
    assert.equal(isSameDocument(base, `${base}#custom-code-msp`), true);
    assert.equal(isHashOnlyChange(base, `${base}#custom-code-msp`), true);
    assert.equal(isHashOnlyChange(base, "https://hacker-fit.org/thanks"), false);
  });
});

describe("form embed detection", () => {
  it("recognizes GoHighLevel and Typeform URLs as form embeds", () => {
    assert.equal(
      isFormEmbedSrc("https://form.typeform.com/to/fyBqxE6Z?typeform-embed=embed-widget"),
      true,
    );
    assert.equal(isFormEmbedSrc("https://api.leadconnectorhq.com/widget/form/abc"), true);
    assert.equal(isFormEmbedSrc("https://fast.wistia.net/embed/iframe/abc"), false);
  });
});

describe("testimonial vs problem copy", () => {
  it("does not treat generic objection quotes as testimonials", () => {
    assert.equal(
      isProblemStatement(
        "\"I've already tried so many things, but nothing sticks once life gets hectic.\"",
      ),
      true,
    );
  });
});

describe("price mentions vs price objections", () => {
  it("labels a bare price word as price_mention, not a price objection", () => {
    const objections = detectObjections({
      url: "https://example.com",
      title: "",
      meta: {
        description: null,
        canonical: null,
        og_title: null,
        og_description: null,
        og_image: null,
        robots: null,
      },
      json_ld: [],
      viewport: { width: 1440, height: 900, scroll_width: 1440, scroll_height: 2000 },
      visible_text: "See the price later",
      headings: [{ level: 2, text: "See the price later", visible: true, position: "below_fold", y: 10 }],
      paragraphs: [],
      buttons: [],
      links: [],
      forms: [],
      videos: [],
      images: [],
      iframes: [],
      timers: [],
      dialogs: [],
      body_overflow_x: false,
    });
    assert.equal(objections.some((item) => item.topic === "price"), false);
    assert.equal(objections.some((item) => item.topic === "price_mention"), true);
  });

  it("does not treat 'if it works for you' as method_works objection handling", () => {
    const objections = detectObjections({
      url: "https://example.com",
      title: "",
      meta: {
        description: null,
        canonical: null,
        og_title: null,
        og_description: null,
        og_image: null,
        robots: null,
      },
      json_ld: [],
      viewport: { width: 1440, height: 900, scroll_width: 1440, scroll_height: 2000 },
      visible_text: "See How They Did This and If It Works For You",
      headings: [
        {
          level: 2,
          text: "Step 1: See How They Did This and If It Works For You",
          visible: true,
          position: "above_fold",
          y: 10,
        },
      ],
      paragraphs: [],
      buttons: [],
      links: [],
      forms: [],
      videos: [],
      images: [],
      iframes: [],
      timers: [],
      dialogs: [],
      body_overflow_x: false,
    });
    assert.equal(objections.some((item) => item.topic === "method_works"), false);
  });
});

describe("Typeform schema parsing", () => {
  it("extracts questions and required flags from a Typeform payload", () => {
    const fields = fieldsFromUnknown([
      {
        fields: [
          {
            id: "1",
            title: "What's your email?",
            type: "email",
            validations: { required: true },
          },
          {
            id: "2",
            title: "What's your current monthly revenue?",
            type: "multiple_choice",
            validations: { required: true },
            properties: { choices: [{ label: "$0-$10k" }, { label: "$10k+" }] },
          },
        ],
      },
    ]);
    assert.equal(fields.length, 2);
    assert.equal(fields[0].purpose, "email");
    assert.equal(fields[0].required, true);
    assert.equal(fields[1].type, "radio");
    assert.deepEqual(fields[1].options, ["$0-$10k", "$10k+"]);
  });

  it("keeps Calendly booking blocks from the Typeform schema", () => {
    const fields = fieldsFromUnknown([
      {
        fields: [
          {
            id: "cal",
            title: "Book a Strategy Session",
            type: "calendly",
            validations: { required: true },
          },
        ],
      },
    ]);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].type, "calendar");
    assert.equal(fields[0].label, "Book a Strategy Session");
    assert.equal(fields[0].required, true);
  });
});
