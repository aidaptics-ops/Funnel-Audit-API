import type {
  DetectedIssue,
  IssueCategory,
  IssueSeverity,
  PageAnalysis,
  PageRecord,
  PageRole,
} from "../types/index.js";

export interface IssueContext {
  role: PageRole;
  record: PageRecord;
  /** Everything except the issue/recommendation sections, already built. */
  sections: Omit<PageAnalysis, "detected_issues" | "recommendations">;
  blocker?: string | null;
  scheduling_expected?: boolean;
}

export interface IssueRule {
  code: string;
  title: string;
  severity: IssueSeverity;
  category: IssueCategory;
  /** Human-readable statement of exactly what triggers this rule. */
  rule: string;
  roles: PageRole[] | "all";
  /** Returns the observed evidence when the rule fires, otherwise null. */
  evaluate: (ctx: IssueContext) => string[] | null;
}

const CONTENT_PAGE_ROLES: PageRole[] = ["landing", "intermediate", "form", "confirmation"];

export const ISSUE_RULES: IssueRule[] = [
  {
    code: "PAGE_BLOCKED",
    title: "Page was served an anti-bot or access-denied screen",
    severity: "critical",
    category: "technical",
    rule: "The captured page matched a challenge/blocked-page signature.",
    roles: "all",
    evaluate: (ctx) => (ctx.blocker ? [ctx.blocker] : null),
  },
  {
    code: "NO_CTA",
    title: "No call-to-action was found on the page",
    severity: "critical",
    category: "conversion",
    rule: "The page exposes zero CTA elements.",
    roles: ["landing", "intermediate", "form"],
    evaluate: (ctx) => (ctx.sections.ctas.count === 0 ? ["0 CTA elements detected"] : null),
  },
  {
    code: "NO_CTA_ABOVE_FOLD",
    title: "No call-to-action above the fold",
    severity: "high",
    category: "conversion",
    rule: "CTAs exist but none render inside the first viewport.",
    roles: ["landing", "intermediate", "form"],
    evaluate: (ctx) =>
      ctx.sections.ctas.count > 0 && ctx.sections.ctas.above_fold_count === 0
        ? [`${ctx.sections.ctas.count} CTA(s) found, all below the fold`]
        : null,
  },
  {
    code: "COMPETING_CTA_DESTINATIONS",
    title: "CTAs point at several different destinations",
    severity: "medium",
    category: "conversion",
    rule: "More than three distinct CTA destinations on one page splits the next action.",
    roles: ["landing", "intermediate", "form"],
    evaluate: (ctx) =>
      ctx.sections.ctas.unique_destinations.length > 3
        ? [
            `${ctx.sections.ctas.unique_destinations.length} distinct CTA destinations`,
            ...ctx.sections.ctas.unique_destinations.slice(0, 6),
          ]
        : null,
  },
  {
    code: "DEAD_CTA_LINK",
    title: "A CTA has no working destination",
    severity: "high",
    category: "technical",
    rule: "A CTA link resolves to '#', 'javascript:' or an empty href.",
    roles: "all",
    evaluate: (ctx) => {
      const dead = ctx.sections.ctas.items.filter(
        (cta) => cta.element === "link" && (cta.destination.kind === "javascript" || cta.destination.kind === "none"),
      );
      return dead.length
        ? dead.slice(0, 5).map((cta) => `"${cta.text}" → ${cta.destination.href ?? "(no href)"}`)
        : null;
    },
  },
  {
    code: "SITE_NAVIGATION_ON_FUNNEL_PAGE",
    title: "Full site navigation is present on a funnel page",
    severity: "medium",
    category: "conversion",
    rule: "A funnel step exposes 5+ navigation links, giving visitors exits before converting.",
    roles: ["landing", "form", "confirmation"],
    evaluate: (ctx) =>
      ctx.sections.navigation.nav_links >= 5
        ? [`${ctx.sections.navigation.nav_links} navigation links in the header/nav region`]
        : null,
  },
  {
    code: "NO_FORM_OR_SCHEDULER",
    title: "No form or scheduler to capture the lead",
    severity: "critical",
    category: "conversion",
    rule: "The page has CTAs but no form, and no scheduling embed was detected.",
    roles: ["landing", "form"],
    evaluate: (ctx) =>
      ctx.sections.forms.count === 0 && !ctx.scheduling_expected && ctx.sections.ctas.count > 0
        ? ["0 forms detected", "no scheduling embed detected"]
        : null,
  },
  {
    code: "FORM_HIGH_FRICTION",
    title: "Lead form asks for a lot before any commitment",
    severity: "medium",
    category: "form",
    rule: "A form has 10+ fields or 8+ required fields.",
    roles: "all",
    evaluate: (ctx) => {
      const heavy = ctx.sections.forms.items.filter(
        (form) => form.field_count >= 10 || form.required_count >= 8,
      );
      return heavy.length
        ? heavy.map((form) => `${form.type} form: ${form.field_count} fields, ${form.required_count} required`)
        : null;
    },
  },
  {
    code: "FORM_FIELDS_UNLABELLED",
    title: "Form fields have no label",
    severity: "medium",
    category: "accessibility",
    rule: "A form contains fields with neither a label nor a name.",
    roles: "all",
    evaluate: (ctx) => {
      const evidence: string[] = [];
      for (const form of ctx.sections.forms.items) {
        const unlabelled = form.fields.filter((field) => !field.label && !field.name);
        if (unlabelled.length) {
          evidence.push(`${form.form_id}: ${unlabelled.length} of ${form.field_count} fields unlabelled`);
        }
      }
      return evidence.length ? evidence : null;
    },
  },
  {
    code: "FORM_MISSING_SUBMIT",
    title: "Form has fields but no detectable submit control",
    severity: "high",
    category: "form",
    rule: "A native form has 1+ fields and no submit button text.",
    roles: "all",
    evaluate: (ctx) => {
      const broken = ctx.sections.forms.items.filter(
        (form) =>
          form.integration.embed_type !== "iframe" && form.field_count > 0 && !form.submit_text,
      );
      return broken.length ? broken.map((form) => `${form.form_id} (${form.field_count} fields, no submit control)`) : null;
    },
  },
  {
    code: "FORM_BELOW_FOLD_ONLY",
    title: "The only form sits below the fold",
    severity: "low",
    category: "conversion",
    rule: "Every detected form renders outside the first viewport.",
    roles: ["landing", "form"],
    evaluate: (ctx) =>
      ctx.sections.forms.count > 0 &&
      ctx.sections.forms.items.every((form) => form.position !== "above_fold")
        ? [`${ctx.sections.forms.count} form(s), none above the fold`]
        : null,
  },
  {
    code: "NO_SOCIAL_PROOF",
    title: "No testimonials or social proof on the page",
    severity: "high",
    category: "trust",
    rule: "Zero testimonials and zero social-proof elements were detected.",
    roles: ["landing", "form"],
    evaluate: (ctx) =>
      ctx.sections.conversion_elements.counts.testimonials === 0 &&
      ctx.sections.conversion_elements.counts.social_proof === 0
        ? ["0 testimonials", "0 social-proof elements"]
        : null,
  },
  {
    code: "PROOF_BELOW_FOLD_ONLY",
    title: "All proof elements are below the fold",
    severity: "low",
    category: "trust",
    rule: "Proof exists but none of it is visible in the first viewport.",
    roles: ["landing", "form"],
    evaluate: (ctx) => {
      const proof = [
        ...ctx.sections.conversion_elements.testimonials,
        ...ctx.sections.conversion_elements.social_proof,
      ];
      return proof.length > 0 && proof.every((item) => item.position !== "above_fold")
        ? [`${proof.length} proof element(s), none above the fold`]
        : null;
    },
  },
  {
    code: "NO_OBJECTION_HANDLING",
    title: "No objection handling or FAQ",
    severity: "low",
    category: "copy",
    rule: "The page has no FAQ section and no objection-handling copy.",
    roles: ["landing"],
    evaluate: (ctx) =>
      ctx.sections.conversion_elements.counts.faq_items === 0 &&
      ctx.sections.conversion_elements.counts.objections === 0
        ? ["0 FAQ items", "0 objection-handling blocks"]
        : null,
  },
  {
    code: "MISSING_H1",
    title: "Page has no H1 headline",
    severity: "medium",
    category: "seo",
    rule: "The document contains zero H1 elements.",
    roles: CONTENT_PAGE_ROLES,
    evaluate: (ctx) => (ctx.sections.page_structure.h1_count === 0 ? ["0 H1 elements"] : null),
  },
  {
    code: "MULTIPLE_H1",
    title: "Page has several H1 headlines",
    severity: "low",
    category: "seo",
    rule: "The document contains more than one H1 element.",
    roles: CONTENT_PAGE_ROLES,
    evaluate: (ctx) =>
      ctx.sections.page_structure.h1_count > 1 ? [`${ctx.sections.page_structure.h1_count} H1 elements`] : null,
  },
  {
    code: "MISSING_META_DESCRIPTION",
    title: "No meta description",
    severity: "low",
    category: "seo",
    rule: "The page has no meta description tag.",
    roles: CONTENT_PAGE_ROLES,
    evaluate: (ctx) => (ctx.sections.page_information.meta_description ? null : ["meta description is empty"]),
  },
  {
    code: "MISSING_TITLE",
    title: "No page title",
    severity: "medium",
    category: "seo",
    rule: "The document title is empty.",
    roles: CONTENT_PAGE_ROLES,
    evaluate: (ctx) => (ctx.sections.page_information.title.trim() ? null : ["document title is empty"]),
  },
  {
    code: "THIN_COPY",
    title: "Very little copy on the page",
    severity: "medium",
    category: "copy",
    rule: "The page carries fewer than 120 words of visible text.",
    roles: ["landing"],
    evaluate: (ctx) =>
      ctx.sections.page_structure.word_count < 120
        ? [`${ctx.sections.page_structure.word_count} words of visible copy`]
        : null,
  },
  {
    code: "VSL_WITHOUT_VIDEO",
    title: "Page reads as a VSL but no video was found",
    severity: "high",
    category: "technical",
    rule: "Classification says vsl/webinar while zero video elements were detected.",
    roles: CONTENT_PAGE_ROLES,
    evaluate: (ctx) =>
      ["vsl", "webinar_registration"].includes(ctx.sections.page_information.page_type) &&
      ctx.sections.videos.count === 0
        ? [`page_type=${ctx.sections.page_information.page_type}`, "0 video elements detected"]
        : null,
  },
  {
    code: "VIDEO_BELOW_FOLD_ONLY",
    title: "Video is only reachable after scrolling",
    severity: "low",
    category: "ux",
    rule: "Videos exist but none render in the first viewport.",
    roles: ["landing"],
    evaluate: (ctx) =>
      ctx.sections.videos.count > 0 && ctx.sections.videos.above_fold_count === 0
        ? [`${ctx.sections.videos.count} video(s), none above the fold`]
        : null,
  },
  {
    code: "BROKEN_IMAGES",
    title: "Images failed to load",
    severity: "high",
    category: "technical",
    rule: "One or more <img> elements finished loading with no intrinsic size.",
    roles: "all",
    evaluate: (ctx) => {
      const broken = ctx.record.technical_snapshot?.broken_images || [];
      return broken.length
        ? [`${broken.length} broken image(s)`, ...broken.slice(0, 5).map((img) => img.src || "(no src)")]
        : null;
    },
  },
  {
    code: "IMAGES_MISSING_ALT",
    title: "Visible images have no alt text",
    severity: "low",
    category: "accessibility",
    rule: "Five or more visible images have an empty alt attribute.",
    roles: "all",
    evaluate: (ctx) => {
      const missing = ctx.sections.tracking_technical.images_missing_alt;
      return missing >= 5 ? [`${missing} visible images without alt text`] : null;
    },
  },
  {
    code: "CONSOLE_ERRORS",
    title: "JavaScript errors on the page",
    severity: "medium",
    category: "technical",
    rule: "The browser console reported one or more errors while the page loaded.",
    roles: "all",
    evaluate: (ctx) => {
      const errors = ctx.sections.tracking_technical.console_errors;
      return errors.length ? [`${errors.length} console error(s)`, ...errors.slice(0, 3)] : null;
    },
  },
  {
    code: "FAILED_REQUESTS",
    title: "Page assets failed to load",
    severity: "medium",
    category: "technical",
    rule: "One or more subresources returned 4xx/5xx or failed outright.",
    roles: "all",
    evaluate: (ctx) => {
      const failed = ctx.sections.tracking_technical.failed_requests;
      return failed.length
        ? [`${failed.length} failed request(s)`, ...failed.slice(0, 3).map((item) => `${item.reason} ${item.url}`)]
        : null;
    },
  },
  {
    code: "NOT_HTTPS",
    title: "Page is not served over HTTPS",
    severity: "high",
    category: "technical",
    rule: "The page URL uses a scheme other than https.",
    roles: "all",
    evaluate: (ctx) => (ctx.sections.page_information.is_https ? null : [ctx.sections.page_information.url]),
  },
  {
    code: "HORIZONTAL_OVERFLOW",
    title: "Page scrolls sideways",
    severity: "medium",
    category: "ux",
    rule: "Document scroll width exceeds the viewport width.",
    roles: "all",
    evaluate: (ctx) => (ctx.sections.tracking_technical.horizontal_overflow ? ["document scrolls horizontally"] : null),
  },
  {
    code: "NO_TRACKING",
    title: "No advertising pixel or analytics detected",
    severity: "high",
    category: "tracking",
    rule: "No pixel, analytics or tag-manager vendor was found in the page scripts or globals.",
    roles: ["landing", "confirmation"],
    evaluate: (ctx) =>
      !ctx.sections.tracking_technical.has_pixel &&
      !ctx.sections.tracking_technical.has_analytics &&
      !ctx.sections.tracking_technical.has_tag_manager
        ? [`${ctx.sections.tracking_technical.script_count} scripts, 0 known tracking vendors`]
        : null,
  },
  {
    code: "NO_CONVERSION_PIXEL_ON_CONFIRMATION",
    title: "Confirmation page carries no conversion pixel",
    severity: "high",
    category: "tracking",
    rule: "The confirmation page has no advertising pixel, so bookings cannot be attributed to ad spend.",
    roles: ["confirmation"],
    evaluate: (ctx) => (ctx.sections.tracking_technical.has_pixel ? null : ["no pixel vendor on the confirmation page"]),
  },
  {
    code: "CONFIRMATION_NO_APPOINTMENT_DETAILS",
    title: "Confirmation page does not restate the appointment",
    severity: "high",
    category: "ux",
    rule: "The confirmation page shows no date, time or meeting link for the booked call.",
    roles: ["confirmation"],
    evaluate: (ctx) =>
      ctx.sections.confirmation_details && !ctx.sections.confirmation_details.appointment.detected
        ? ["no date/time/meeting-link text found on the confirmation page"]
        : null,
  },
  {
    code: "CONFIRMATION_NO_NEXT_STEPS",
    title: "Confirmation page gives no next steps",
    severity: "medium",
    category: "ux",
    rule: "The confirmation page lists no next-step instructions.",
    roles: ["confirmation"],
    evaluate: (ctx) =>
      ctx.sections.confirmation_details && ctx.sections.confirmation_details.next_steps.length === 0
        ? ["0 next-step instructions detected"]
        : null,
  },
  {
    code: "CONFIRMATION_NO_CALENDAR_LINK",
    title: "No add-to-calendar link on the confirmation page",
    severity: "medium",
    category: "ux",
    rule: "The confirmation page offers no calendar link, which costs show-up rate.",
    roles: ["confirmation"],
    evaluate: (ctx) =>
      ctx.sections.confirmation_details &&
      ctx.sections.confirmation_details.appointment.add_to_calendar_links.length === 0
        ? ["no add-to-calendar link detected"]
        : null,
  },
  {
    code: "CONFIRMATION_NO_PREPARATION_CONTENT",
    title: "Confirmation page has nothing to warm the lead up",
    severity: "medium",
    category: "conversion",
    rule: "The confirmation page carries no video, preparation instructions or educational content.",
    roles: ["confirmation"],
    evaluate: (ctx) => {
      const details = ctx.sections.confirmation_details;
      if (!details) return null;
      return !details.has_preparation_content &&
        !details.has_educational_content &&
        ctx.sections.videos.count === 0
        ? ["no video", "no preparation instructions", "no educational content"]
        : null;
    },
  },
  {
    code: "CONFIRMATION_DEAD_END",
    title: "Confirmation page is a dead end",
    severity: "medium",
    category: "conversion",
    rule: "The confirmation page has no CTA and no upsell.",
    roles: ["confirmation"],
    evaluate: (ctx) => {
      const details = ctx.sections.confirmation_details;
      if (!details) return null;
      return ctx.sections.ctas.count === 0 && details.upsells.length === 0
        ? ["0 CTAs", "0 upsells or next offers"]
        : null;
    },
  },
  {
    code: "CONFIRMATION_NO_PROOF",
    title: "Confirmation page carries no proof",
    severity: "low",
    category: "trust",
    rule: "The confirmation page shows no testimonials or social proof to reduce no-shows.",
    roles: ["confirmation"],
    evaluate: (ctx) =>
      ctx.sections.conversion_elements.counts.testimonials === 0 &&
      ctx.sections.conversion_elements.counts.social_proof === 0
        ? ["0 testimonials", "0 social-proof elements"]
        : null,
  },
];

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function detectIssues(ctx: IssueContext): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  for (const rule of ISSUE_RULES) {
    if (rule.roles !== "all" && !rule.roles.includes(ctx.role)) continue;
    let evidence: string[] | null = null;
    try {
      evidence = rule.evaluate(ctx);
    } catch {
      evidence = null;
    }
    if (!evidence || !evidence.length) continue;
    issues.push({
      code: rule.code,
      title: rule.title,
      severity: rule.severity,
      category: rule.category,
      page_role: ctx.role,
      page_url: ctx.sections.page_information.url,
      rule: rule.rule,
      evidence,
      detected_by: "deterministic_rule",
    });
  }

  return sortIssues(issues);
}

export function sortIssues(issues: DetectedIssue[]): DetectedIssue[] {
  return [...issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
  );
}

export function countBySeverity(issues: DetectedIssue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

export type { PageRecord };
