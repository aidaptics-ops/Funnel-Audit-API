import type { DetectedIssue, Recommendation } from "../types/index.js";

/** One fix per rule, so a recommendation is always traceable to its issue. */
const PLAYBOOK: Record<string, { recommendation: string; rationale: string }> = {
  PAGE_BLOCKED: {
    recommendation: "Re-run the capture from a normal browser session on this network before drawing conclusions.",
    rationale: "The page returned a challenge screen, so the captured evidence is not the real funnel page.",
  },
  NO_CTA: {
    recommendation: "Add a single, explicit primary action to the page.",
    rationale: "A page with no call-to-action cannot convert traffic into leads.",
  },
  NO_CTA_ABOVE_FOLD: {
    recommendation: "Place the primary CTA inside the first viewport, next to the headline or video.",
    rationale: "Visitors who never scroll never see the offer.",
  },
  COMPETING_CTA_DESTINATIONS: {
    recommendation: "Collapse the CTAs onto one destination and repeat that single action down the page.",
    rationale: "Several competing next steps split attention and reduce completion of the main one.",
  },
  DEAD_CTA_LINK: {
    recommendation: "Point the CTA at the real destination or wire up its click handler.",
    rationale: "A CTA with no destination silently drops everyone who clicks it.",
  },
  SITE_NAVIGATION_ON_FUNNEL_PAGE: {
    recommendation: "Strip the header navigation on funnel steps, leaving only the logo and the CTA.",
    rationale: "Navigation links give visitors an exit before they take the funnel action.",
  },
  NO_FORM_OR_SCHEDULER: {
    recommendation: "Add the lead form or scheduler the CTAs promise, or link them to the page that has it.",
    rationale: "The page asks for an action but offers no way to complete it.",
  },
  FORM_HIGH_FRICTION: {
    recommendation: "Cut the form to the fields you act on, or split it into steps with contact details first.",
    rationale: "Long forms lose applicants partway through, and the abandoned answers are unusable.",
  },
  FORM_FIELDS_UNLABELLED: {
    recommendation: "Give every field a visible label tied to the input.",
    rationale: "Unlabelled fields break autofill and assistive technology, and raise error rates.",
  },
  FORM_MISSING_SUBMIT: {
    recommendation: "Verify the form's submit control renders and is reachable by keyboard.",
    rationale: "A form with no submit control cannot be completed at all.",
  },
  FORM_BELOW_FOLD_ONLY: {
    recommendation: "Repeat the form (or an anchor button to it) inside the first viewport.",
    rationale: "Ready-to-convert visitors should not have to hunt for the form.",
  },
  NO_SOCIAL_PROOF: {
    recommendation: "Add named results, testimonials or client logos near the primary CTA.",
    rationale: "Cold traffic needs evidence before handing over contact details.",
  },
  PROOF_BELOW_FOLD_ONLY: {
    recommendation: "Move one strong proof element above the fold.",
    rationale: "Proof only works if it is seen before the decision point.",
  },
  NO_OBJECTION_HANDLING: {
    recommendation: "Add a short FAQ covering price, time commitment and fit.",
    rationale: "Unanswered objections are resolved by leaving the page.",
  },
  MISSING_H1: {
    recommendation: "Mark the main headline up as an H1.",
    rationale: "A missing H1 weakens both the visual hierarchy and search indexing.",
  },
  MULTIPLE_H1: {
    recommendation: "Keep one H1 and demote the rest to H2.",
    rationale: "Multiple H1s blur which promise is the main one.",
  },
  MISSING_META_DESCRIPTION: {
    recommendation: "Write a meta description that repeats the offer.",
    rationale: "It controls the snippet shown when the page is shared or indexed.",
  },
  MISSING_TITLE: {
    recommendation: "Set a document title describing the offer.",
    rationale: "The title is the tab label, the share label and the search label.",
  },
  THIN_COPY: {
    recommendation: "Expand the page with the offer, who it is for, and what happens after opting in.",
    rationale: "Thin pages leave the visitor guessing what they are agreeing to.",
  },
  VSL_WITHOUT_VIDEO: {
    recommendation: "Check the video embed renders for real visitors on this device profile.",
    rationale: "The page is built around a video that did not load during the capture.",
  },
  VIDEO_BELOW_FOLD_ONLY: {
    recommendation: "Move the video into the first viewport or add a play prompt above it.",
    rationale: "If the video is the pitch, it needs to be visible without scrolling.",
  },
  BROKEN_IMAGES: {
    recommendation: "Fix or remove the image sources that fail to load.",
    rationale: "Broken images read as neglect and damage trust on a page asking for contact details.",
  },
  IMAGES_MISSING_ALT: {
    recommendation: "Add alt text to content images.",
    rationale: "Alt text carries the message when images fail and for screen-reader users.",
  },
  CONSOLE_ERRORS: {
    recommendation: "Clear the JavaScript errors, starting with anything thrown before the form renders.",
    rationale: "Script errors can stop form validation, tracking or the embed from working.",
  },
  FAILED_REQUESTS: {
    recommendation: "Fix the failing asset requests or drop the dead references.",
    rationale: "Failed requests slow the page and can break tracking or layout.",
  },
  NOT_HTTPS: {
    recommendation: "Serve the funnel over HTTPS and redirect the HTTP version.",
    rationale: "Browsers warn on insecure pages that collect personal details.",
  },
  HORIZONTAL_OVERFLOW: {
    recommendation: "Constrain the overflowing element so the page fits the viewport width.",
    rationale: "Sideways scrolling makes the page feel broken, especially on phones.",
  },
  NO_TRACKING: {
    recommendation: "Install the ad pixel and analytics before spending on traffic.",
    rationale: "Without tracking, no funnel step can be measured or optimised.",
  },
  NO_CONVERSION_PIXEL_ON_CONFIRMATION: {
    recommendation: "Fire a conversion event on the confirmation page.",
    rationale: "Booked calls cannot be attributed to campaigns without a conversion signal.",
  },
  CONFIRMATION_NO_APPOINTMENT_DETAILS: {
    recommendation: "Restate the date, time, timezone and meeting link on the confirmation page.",
    rationale: "People forget the details immediately after booking, which drives no-shows.",
  },
  CONFIRMATION_NO_NEXT_STEPS: {
    recommendation: "Spell out what happens next and what the lead should do before the call.",
    rationale: "Clear instructions between booking and call raise show-up rate.",
  },
  CONFIRMATION_NO_CALENDAR_LINK: {
    recommendation: "Add an add-to-calendar link for the booked slot.",
    rationale: "A calendar entry with a reminder is the cheapest no-show reduction available.",
  },
  CONFIRMATION_NO_PREPARATION_CONTENT: {
    recommendation: "Add a short pre-call video or preparation checklist to the confirmation page.",
    rationale: "The window between booking and call is the best time to pre-sell.",
  },
  CONFIRMATION_DEAD_END: {
    recommendation: "Give the confirmation page one next action, such as a case study or a resource.",
    rationale: "A dead end wastes the highest-intent moment in the funnel.",
  },
  CONFIRMATION_NO_PROOF: {
    recommendation: "Add one or two results stories to the confirmation page.",
    rationale: "Proof after booking keeps the lead committed until the call.",
  },
};

export function recommendationsFor(issues: DetectedIssue[]): Recommendation[] {
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const issue of issues) {
    const key = `${issue.page_role}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = PLAYBOOK[issue.code];
    if (!entry) continue;
    out.push({
      issue_code: issue.code,
      priority: issue.severity,
      page_role: issue.page_role,
      recommendation: entry.recommendation,
      rationale: entry.rationale,
    });
  }
  return out;
}

export { PLAYBOOK };
