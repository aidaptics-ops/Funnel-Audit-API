import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPage } from "../src/classification/page_classifier.js";
import type { CtaRecord, DomSnapshot, FormRecord, VideoRecord } from "../src/types/index.js";

function snapshot(partial: Partial<DomSnapshot>): DomSnapshot {
  return {
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
    visible_text: "",
    headings: [],
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
    ...partial,
  };
}

function form(partial: Partial<FormRecord>): FormRecord {
  return {
    type: "unknown",
    selector: "form",
    action: null,
    method: "post",
    field_count: 2,
    fields: [],
    submit_text: "Submit",
    visible: true,
    position: "above_fold",
    multi_step: false,
    progress_indicator: null,
    estimated_completion_burden: "low",
    friction: null,
    ...partial,
  };
}

describe("classifyPage", () => {
  it("classifies a webinar registration page from observable evidence", () => {
    const result = classifyPage({
      snapshot: snapshot({
        url: "https://example.com/webinar",
        title: "Free Webinar",
        visible_text: "Join the live webinar tomorrow at 2:00pm EST. Register to save your spot.",
      }),
      forms: [
        form({
          type: "webinar_registration",
          submit_text: "Register now",
          fields: [
            {
              name: "email",
              id: "email",
              label: "Email",
              type: "email",
              placeholder: null,
              required: true,
              autocomplete: "email",
              options: [],
              purpose: "email",
              checked: null,
              value_present: false,
              selector: "#email",
            },
          ],
        }),
      ],
      videos: [],
      ctas: [],
    });

    assert.equal(result.page_type, "webinar_registration");
    assert.ok(result.confidence < 1);
    assert.ok(result.evidence.some((item) => /webinar/i.test(item)));
  });

  it("classifies a VSL when a visible video is above the fold", () => {
    const video: VideoRecord = {
      provider: "vimeo",
      embedded: true,
      visible: true,
      autoplay: false,
      duration: null,
      src: "https://player.vimeo.com/video/1",
      position: "above_fold",
      play_button_visible: true,
      thumbnail: null,
      analysis_limitation: "Cross-origin iframe contents cannot be inspected",
    };
    const cta: CtaRecord = {
      text: "Apply Now",
      type: "button",
      href: null,
      visible: true,
      position: "below_fold",
      section: "footer",
      y: 1200,
      supporting_copy: null,
      headline_above: null,
      stated_outcome: null,
    };
    const result = classifyPage({
      snapshot: snapshot({
        url: "https://example.com/vsl",
        title: "Watch this training",
        visible_text: "Press play to watch the video.",
        videos: [video],
      }),
      forms: [],
      videos: [video],
      ctas: [cta],
    });
    assert.equal(result.page_type, "vsl");
  });

  it("returns unknown with low confidence when evidence is missing", () => {
    const result = classifyPage({
      snapshot: snapshot({ title: "Example Domain", visible_text: "Example Domain" }),
      forms: [],
      videos: [],
      ctas: [],
    });
    assert.equal(result.page_type, "unknown");
    assert.ok(result.confidence <= 0.35);
  });
});
