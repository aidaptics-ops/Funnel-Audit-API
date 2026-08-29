import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzePage,
  classifyDestination,
  extractAppointment,
  formIntegration,
} from "../src/analysis/page_analyzer.js";
import { businessNameFrom } from "../src/analysis/funnel_summary.js";
import { cta, form, metadata, pageRecord } from "./helpers/records.js";

describe("CTA destinations", () => {
  const page = "https://example.com/offer";

  it("classifies internal, external, scheduler and dead links", () => {
    assert.equal(classifyDestination("/apply", page).kind, "internal");
    assert.equal(classifyDestination("https://other.com/x", page).kind, "external");
    assert.equal(classifyDestination("https://calendly.com/acme/30min", page).kind, "scheduler");
    assert.equal(classifyDestination("https://calendly.com/acme/30min", page).provider, "calendly");
    assert.equal(classifyDestination("https://form.typeform.com/to/abc", page).kind, "form_embed");
    assert.equal(classifyDestination("#pricing", page).kind, "anchor");
    assert.equal(classifyDestination("javascript:void(0)", page).kind, "javascript");
    assert.equal(classifyDestination(null, page).kind, "none");
    assert.equal(classifyDestination("mailto:hi@example.com", page).kind, "mailto");
  });
});

describe("form integrations", () => {
  it("labels an embedded Typeform", () => {
    const integration = formIntegration(
      form({ method: "iframe", action: "https://form.typeform.com/to/abc", selector: 'iframe[src*="typeform"]' }),
    );
    assert.equal(integration.provider, "typeform");
    assert.equal(integration.embed_type, "iframe");
    assert.equal(integration.host, "form.typeform.com");
    assert.ok(integration.limitation);
  });

  it("labels a GoHighLevel embed and a native form", () => {
    assert.equal(
      formIntegration(form({ method: "iframe", action: "https://api.leadconnectorhq.com/widget/form/x" })).provider,
      "gohighlevel",
    );
    const native = formIntegration(form({ method: "post", action: "https://example.activehosted.com/proc.php" }));
    assert.equal(native.provider, "activecampaign");
    assert.equal(native.embed_type, "native");
  });
});

describe("landing page analysis", () => {
  const record = pageRecord({
    ctas: [cta("Book my free audit", "https://calendly.com/acme/30min"), cta("Apply now", "/apply", false)],
    forms: [
      form({
        fields: [
          { name: "email", id: null, label: "Email", type: "email", placeholder: null, required: true, autocomplete: null, options: [], purpose: "email", checked: null, value_present: false, selector: "#email" },
          { name: "name", id: null, label: "Name", type: "text", placeholder: null, required: true, autocomplete: null, options: [], purpose: "full_name", checked: null, value_present: false, selector: "#name" },
        ],
      }),
    ],
    links: [
      { text: "Home", href: "https://example.com/", visible: true, position: "above_fold", in_nav: true, y: 10 },
      { text: "Blog", href: "https://example.com/blog", visible: true, position: "above_fold", in_nav: true, y: 10 },
    ],
  });

  const analysis = analyzePage({ record, role: "landing", sequence: 1, metadata: metadata() });

  it("produces the full section set with a stable schema version", () => {
    assert.equal(analysis.funnel_metadata.schema_version, "1.0");
    for (const key of [
      "page_information",
      "videos",
      "ctas",
      "forms",
      "form_integrations",
      "navigation",
      "page_structure",
      "conversion_elements",
      "tracking_technical",
      "detected_issues",
      "recommendations",
    ]) {
      assert.ok(key in analysis, `missing section ${key}`);
    }
    assert.equal(analysis.confirmation_details, null);
  });

  it("summarises CTAs, forms and navigation", () => {
    assert.equal(analysis.ctas.count, 2);
    assert.equal(analysis.ctas.above_fold_count, 1);
    assert.equal(analysis.ctas.primary?.destination.provider, "calendly");
    assert.equal(analysis.forms.count, 1);
    assert.equal(analysis.forms.items[0].required_count, 2);
    assert.ok(analysis.forms.primary_form_id);
    assert.equal(analysis.navigation.nav_links, 2);
  });

  it("flags missing proof and missing tracking deterministically", () => {
    const codes = analysis.detected_issues.map((issue) => issue.code);
    assert.ok(codes.includes("NO_SOCIAL_PROOF"));
    assert.ok(codes.includes("NO_TRACKING"));
    const proof = analysis.detected_issues.find((issue) => issue.code === "NO_SOCIAL_PROOF");
    assert.ok(proof?.evidence.length);
    assert.equal(proof?.detected_by, "deterministic_rule");
    assert.ok(analysis.recommendations.some((item) => item.issue_code === "NO_SOCIAL_PROOF"));
  });

  it("does not flag tracking when a pixel is present", () => {
    const tracked = analyzePage({
      record: pageRecord({
        technical_snapshot: {
          ...record.technical_snapshot!,
          scripts: [{ src: "https://connect.facebook.net/en_US/fbevents.js", host: "connect.facebook.net", inline_snippet: null }],
          tracking_globals: ["fbq"],
        },
      }),
      role: "landing",
      sequence: 1,
      metadata: metadata(),
    });
    assert.equal(tracked.tracking_technical.has_pixel, true);
    assert.equal(
      tracked.detected_issues.some((issue) => issue.code === "NO_TRACKING"),
      false,
    );
  });
});

describe("confirmation page analysis", () => {
  const record = pageRecord({
    url: "https://example.com/thank-you",
    page_type: "confirmation",
    title: "You're booked | Example Co",
    visible_text:
      "You are scheduled. Your call is on Friday, March 6 at 10:30 am EST with Jane Doe. Next step: check your email for the Zoom link.",
    headings: [{ level: 1, text: "You're booked", visible: true, position: "above_fold", y: 80 }],
    paragraphs: [
      {
        text: "Next step: check your email for the Zoom link and add the event to your calendar.",
        visible: true,
        position: "above_fold",
        y: 200,
      },
    ],
    links: [
      {
        text: "Add to calendar",
        href: "https://calendar.google.com/calendar/render?action=TEMPLATE",
        visible: true,
        position: "above_fold",
        in_nav: false,
        y: 300,
      },
      { text: "Join", href: "https://zoom.us/j/123456", visible: true, position: "above_fold", in_nav: false, y: 320 },
    ],
  });

  it("extracts appointment details from page text and links", () => {
    const appointment = extractAppointment(record);
    assert.equal(appointment.detected, true);
    assert.match(appointment.date_text ?? "", /Mar/i);
    assert.equal(appointment.time_text, "10:30 am");
    assert.equal(appointment.timezone, "EST");
    assert.equal(appointment.meeting_link, "https://zoom.us/j/123456");
    assert.equal(appointment.add_to_calendar_links.length, 1);
  });

  it("reads an appointment out of an embedded scheduler frame", () => {
    const embedded = extractAppointment({
      ...record,
      visible_text: "",
      links: [],
      embedded_text: [
        {
          url: "https://calendly.com/acme/30min/invitees/abc",
          text: "You are scheduled. A calendar invitation has been sent. 10:30am - 11:00am, Friday, March 6, 2026 Eastern Time",
        },
      ],
    });
    assert.equal(embedded.detected, true, "date + time inside the embed is enough to confirm the slot");
    assert.equal(embedded.time_text, "10:30am");
    assert.match(embedded.date_text ?? "", /Mar/i);
    assert.equal(embedded.timezone, "Eastern Time");
  });

  it("uses the confirmation section of the schema", () => {
    const analysis = analyzePage({ record, role: "confirmation", sequence: 4, metadata: metadata() });
    assert.equal(analysis.page_information.page_role, "confirmation");
    assert.equal(analysis.confirmation_details?.is_confirmation_page, true);
    assert.ok(analysis.confirmation_details?.next_steps.length);
    assert.equal(analysis.confirmation_details?.appointment.detected, true);
    const codes = analysis.detected_issues.map((issue) => issue.code);
    assert.equal(codes.includes("CONFIRMATION_NO_APPOINTMENT_DETAILS"), false);
    assert.equal(codes.includes("CONFIRMATION_NO_CALENDAR_LINK"), false);
    assert.ok(codes.includes("NO_CONVERSION_PIXEL_ON_CONFIRMATION"));
  });

  it("flags a bare confirmation page", () => {
    const bare = analyzePage({
      record: pageRecord({
        url: "https://example.com/thanks",
        page_type: "thank_you",
        visible_text: "Thanks.",
        paragraphs: [],
        links: [],
      }),
      role: "confirmation",
      sequence: 3,
      metadata: metadata(),
    });
    const codes = bare.detected_issues.map((issue) => issue.code);
    assert.ok(codes.includes("CONFIRMATION_NO_APPOINTMENT_DETAILS"));
    assert.ok(codes.includes("CONFIRMATION_NO_NEXT_STEPS"));
    assert.ok(codes.includes("CONFIRMATION_DEAD_END"));
  });
});

describe("business name", () => {
  it("prefers structured data, then the title tail, then the host", () => {
    assert.equal(
      businessNameFrom(pageRecord({ json_ld: [{ "@type": "Organization", name: "Acme Coaching" }] })),
      "Acme Coaching",
    );
    assert.equal(businessNameFrom(pageRecord()), "Example Co");
    assert.equal(businessNameFrom(pageRecord({ title: "Landing" })), "example.com");
  });
});
