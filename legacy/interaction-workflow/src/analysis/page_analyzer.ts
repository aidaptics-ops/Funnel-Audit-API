import { embedProvider, isCalendarEmbedSrc, isFormEmbedSrc, schedulerProvider } from "../extraction/embed_hosts.js";
import type { ConsoleErrorRecord, FailedRequestRecord } from "../crawler/network_capture.js";
import type { SchedulingPresence } from "../crawler/scheduling_detector.js";
import type {
  AnalyzedCta,
  AnalyzedForm,
  AppointmentDetails,
  FormIntegration,
  FormRecord,
  FunnelMetadata,
  PageAnalysis,
  PageRecord,
  PageRole,
} from "../types/index.js";
import { detectIssues } from "./issue_detector.js";
import { recommendationsFor } from "./recommendations.js";
import { detectTracking, thirdPartyHosts } from "./tracking_detector.js";

export interface AnalyzePageInput {
  record: PageRecord;
  role: PageRole;
  sequence: number;
  metadata: FunnelMetadata;
  network?: { failures: FailedRequestRecord[]; consoleErrors: ConsoleErrorRecord[] };
  blocker?: string | null;
  scheduling?: SchedulingPresence | null;
}

const MEETING_LINK = /zoom\.us\/j\/|meet\.google\.com|teams\.microsoft\.com|whereby\.com|gotomeeting\.com/i;
const CALENDAR_LINK =
  /calendar\.google\.com\/calendar\/render|outlook\.(live|office)\.com\/calendar|\.ics(\?|$)|addevent|addtocalendar/i;
const DATE_TEXT =
  /(?:\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\s+)?\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?/i;
const DATE_NUMERIC = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/;
const TIME_TEXT = /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i;
const TIMEZONE_TEXT =
  /\b(?:UTC|GMT)\s*[+-]\d{1,2}(?::\d{2})?\b|\b(?:E[SD]T|C[SD]T|M[SD]T|P[SD]T|BST|CET|CEST|IST|AEST)\b|\b(?:Eastern|Central|Mountain|Pacific|India Standard|British Summer|Central European)\s+Time\b/i;
const DURATION_TEXT = /\b\d{1,3}\s*(?:min|minute|minutes|hour|hours|hr|hrs)\b/i;
const MEETING_HOST = /\bwith\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)?)/;
const UPSELL_TEXT =
  /\b(while you wait|in the meantime|special offer|one[- ]time offer|limited time|upgrade|bonus|book a second|add on|order now|get instant access)\b/i;
const NEXT_STEP_TEXT =
  /\b(next step|what happens next|check your (email|inbox)|add (this|it|the event) to your calendar|before (the|your) call|come prepared|watch (this|the) video|join (the )?(zoom|call|meeting)|we(?:'|’)?ll (call|email|send))\b/i;
const BOOKED_LINE = /[^.!?]*\b(you are scheduled|you'?re scheduled|is scheduled|confirmed)\b[^.!?]*/i;

export function analyzePage(input: AnalyzePageInput): PageAnalysis {
  const { record, role, sequence, metadata } = input;
  const technical = record.technical_snapshot;
  const viewport = technical?.viewport || { width: 0, height: 0, scroll_width: 0, scroll_height: 0 };

  const ctas = record.ctas.map((cta) => analyzeCta(cta, record.url));
  const forms = record.forms.map((form, index) => analyzeForm(form, index, input.scheduling));
  const trackingSignals = detectTracking(record);
  const navigation = analyzeNavigation(record);
  const words = record.visible_text.split(/\s+/).filter(Boolean).length;

  const sections: Omit<PageAnalysis, "detected_issues" | "recommendations"> = {
    funnel_metadata: metadata,
    page_information: {
      page_role: role,
      sequence,
      url: record.url,
      canonical_url: record.canonical_url,
      title: record.title,
      meta_description: record.meta_description,
      og_title: null,
      og_image: null,
      language: technical?.language ?? null,
      page_type: record.page_type,
      funnel_stage: record.funnel_stage ?? null,
      classification_confidence: record.classification_confidence,
      classification_evidence: record.classification_evidence,
      captured_at: record.timestamp,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        scroll_height: viewport.scroll_height,
      },
      is_https: record.url.startsWith("https://"),
    },
    videos: {
      count: record.videos.length,
      above_fold_count: record.videos.filter((video) => video.position === "above_fold").length,
      autoplay_count: record.videos.filter((video) => video.autoplay === true).length,
      providers: unique(record.videos.map((video) => video.provider)),
      items: record.videos,
      limitations: unique(
        record.videos.map((video) => video.analysis_limitation).filter((item): item is string => Boolean(item)),
      ),
    },
    ctas: {
      count: ctas.length,
      above_fold_count: ctas.filter((cta) => cta.above_fold).length,
      primary: pickPrimaryCta(ctas),
      unique_destinations: unique(
        ctas.map((cta) => cta.destination.href).filter((href): href is string => Boolean(href)),
      ),
      items: ctas,
    },
    forms: {
      count: forms.length,
      primary_form_id: pickPrimaryForm(forms)?.form_id ?? null,
      items: forms,
    },
    form_integrations: dedupeIntegrations(forms.map((form) => form.integration)),
    navigation,
    page_structure: {
      heading_outline: record.headings.slice(0, 60).map((heading) => ({
        level: heading.level,
        text: heading.text,
        position: heading.position,
      })),
      h1_count: record.headings.filter((heading) => heading.level === 1).length,
      heading_count: record.headings.length,
      paragraph_count: record.paragraphs.length,
      word_count: words,
      scroll_height: viewport.scroll_height,
      sections: unique(record.ctas.map((cta) => cta.section).filter((item): item is string => Boolean(item))),
      above_the_fold: record.above_the_fold,
      key_copy: {
        headline: record.above_the_fold.hero_heading || record.headings[0]?.text || null,
        subheadline: record.above_the_fold.hero_subheading,
        offer: record.above_the_fold.primary_offer,
        top_paragraphs: record.paragraphs
          .filter((paragraph) => paragraph.visible && paragraph.text.length > 30)
          .slice(0, 12)
          .map((paragraph) => paragraph.text),
      },
    },
    conversion_elements: {
      testimonials: record.testimonials,
      social_proof: record.social_proof,
      pricing: record.pricing,
      urgency: record.urgency_elements,
      faq_sections: record.faq_sections,
      benefit_stack: record.benefit_stack,
      objection_handling: record.objection_handling,
      bonuses: record.attendance_bonuses,
      one_time_offer: record.one_time_offer,
      proof_placement: record.proof_placement,
      counts: {
        testimonials: record.testimonials.length,
        social_proof: record.social_proof.length,
        pricing: record.pricing.length,
        urgency: record.urgency_elements.length,
        faq_items: record.faq_sections.reduce((total, section) => total + section.items.length, 0),
        benefits: record.benefit_stack.length,
        objections: record.objection_handling.length,
      },
    },
    tracking_technical: {
      signals: trackingSignals,
      has_pixel: trackingSignals.some((signal) => signal.kind === "pixel"),
      has_analytics: trackingSignals.some((signal) => signal.kind === "analytics"),
      has_tag_manager: trackingSignals.some((signal) => signal.kind === "tag_manager"),
      third_party_hosts: thirdPartyHosts(record),
      script_count: technical?.scripts.length ?? 0,
      console_errors: (input.network?.consoleErrors || []).map((error) => error.text),
      failed_requests: (input.network?.failures || []).map((failure) => ({
        url: failure.url,
        status: failure.status,
        reason: failure.reason,
      })),
      horizontal_overflow: technical?.body_overflow_x ?? false,
      broken_images: technical?.broken_images.length ?? 0,
      images_missing_alt: technical?.images_missing_alt ?? 0,
      iframes: record.iframes,
      technical_events: record.technical_events,
    },
    confirmation_details: role === "confirmation" ? analyzeConfirmation(record) : null,
    screenshots: record.screenshots,
  };

  const issues = detectIssues({
    role,
    record,
    sections,
    blocker: input.blocker ?? null,
    scheduling_expected: Boolean(input.scheduling?.detected),
  });

  return { ...sections, detected_issues: issues, recommendations: recommendationsFor(issues) };
}

/* ------------------------------- CTAs ------------------------------- */

export function analyzeCta(cta: PageRecord["ctas"][number], pageUrl: string): AnalyzedCta {
  return {
    text: cta.text,
    element: cta.type,
    above_fold: cta.position === "above_fold",
    position: cta.position,
    y: cta.y,
    section: cta.section,
    visible: cta.visible,
    destination: classifyDestination(cta.href, pageUrl),
    supporting_copy: cta.supporting_copy,
    stated_outcome: cta.stated_outcome,
  };
}

export function classifyDestination(href: string | null, pageUrl: string): AnalyzedCta["destination"] {
  if (!href || !href.trim()) {
    return { href: null, kind: "none", host: null, provider: null };
  }
  const raw = href.trim();
  if (/^javascript:/i.test(raw) || raw === "#") {
    return { href: raw, kind: "javascript", host: null, provider: null };
  }
  if (raw.startsWith("#")) {
    return { href: raw, kind: "anchor", host: null, provider: null };
  }
  if (/^mailto:/i.test(raw)) return { href: raw, kind: "mailto", host: null, provider: null };
  if (/^tel:/i.test(raw)) return { href: raw, kind: "tel", host: null, provider: null };

  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return { href: raw, kind: "unknown", host: null, provider: null };
  }

  const scheduler = schedulerProvider(url.href);
  if (scheduler) return { href: url.href, kind: "scheduler", host: url.hostname, provider: scheduler };
  if (isFormEmbedSrc(url.href)) {
    return { href: url.href, kind: "form_embed", host: url.hostname, provider: embedProvider(url.href) };
  }

  let pageHost: string | null = null;
  let pagePath: string | null = null;
  try {
    const parsed = new URL(pageUrl);
    pageHost = parsed.hostname.replace(/^www\./, "");
    pagePath = parsed.pathname;
  } catch {
    pageHost = null;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (pageHost && host === pageHost) {
    const samePath = pagePath !== null && url.pathname === pagePath;
    return {
      href: url.href,
      kind: samePath && url.hash ? "anchor" : "internal",
      host: url.hostname,
      provider: null,
    };
  }
  return { href: url.href, kind: "external", host: url.hostname, provider: embedProvider(url.href) };
}

function pickPrimaryCta(ctas: AnalyzedCta[]): AnalyzedCta | null {
  const visible = ctas.filter((cta) => cta.visible);
  return (
    visible.find((cta) => cta.above_fold && cta.destination.kind !== "javascript") ||
    visible.find((cta) => cta.destination.kind === "scheduler" || cta.destination.kind === "form_embed") ||
    visible[0] ||
    ctas[0] ||
    null
  );
}

/* ------------------------------- Forms ------------------------------ */

export function analyzeForm(
  form: FormRecord,
  index: number,
  scheduling?: SchedulingPresence | null,
): AnalyzedForm {
  const integration = formIntegration(form);
  const leadsToScheduler =
    integration.provider === "calendly" ||
    Boolean(schedulerProvider(form.action)) ||
    form.fields.some((field) => field.type === "calendar") ||
    (form.type === "booking" && Boolean(scheduling?.detected));

  return {
    form_id: `form_${String(index + 1).padStart(2, "0")}_${integration.provider}`,
    type: form.type,
    integration,
    selector: form.selector,
    action: form.action,
    visible: form.visible,
    position: form.position,
    field_count: form.field_count,
    required_count: form.fields.filter((field) => field.required).length,
    submit_text: form.submit_text,
    multi_step: form.multi_step,
    progress_indicator: form.progress_indicator,
    estimated_completion_burden: form.estimated_completion_burden,
    friction: form.friction,
    leads_to_scheduler: leadsToScheduler,
    fields: form.fields.map((field) => ({
      label: field.label,
      name: field.name,
      type: field.type,
      purpose: field.purpose,
      required: field.required,
      option_count: field.options.length,
    })),
  };
}

export function formIntegration(form: FormRecord): FormIntegration {
  const src = form.action;
  const embedded = form.method === "iframe";
  const provider = embedded ? embedProvider(src) || "iframe" : nativeProvider(src);
  let host: string | null = null;
  if (src) {
    try {
      host = new URL(src).hostname;
    } catch {
      host = null;
    }
  }

  const technology = embedded
    ? `${provider} embedded iframe`
    : form.method === "unknown"
      ? "unlabelled fields outside a <form> element"
      : `native HTML form (${form.method.toUpperCase()}${host ? ` → ${host}` : ""})`;

  return {
    provider,
    technology,
    embed_type: embedded ? "iframe" : form.method === "unknown" ? "orphan_fields" : "native",
    src,
    host,
    inspectable: !embedded,
    limitation: embedded ? "Cross-origin embed; fields are read through Playwright frame APIs" : null,
  };
}

/** Best-guess platform behind a native form, from its action host. */
function nativeProvider(action: string | null): string {
  if (!action) return "native";
  const embed = embedProvider(action);
  if (embed) return embed;
  const known: Array<[RegExp, string]> = [
    [/activehosted\.com|activecampaign/i, "activecampaign"],
    [/convertkit|kit\.com/i, "convertkit"],
    [/mailchimp|list-manage\.com/i, "mailchimp"],
    [/hubspot/i, "hubspot"],
    [/klaviyo/i, "klaviyo"],
    [/clickfunnels/i, "clickfunnels"],
    [/kajabi/i, "kajabi"],
    [/kartra/i, "kartra"],
    [/systeme\.io/i, "systeme_io"],
    [/gohighlevel|leadconnector|msgsndr/i, "gohighlevel"],
    [/webflow/i, "webflow"],
    [/wpforms|wp-json|admin-ajax\.php/i, "wordpress"],
  ];
  for (const [pattern, name] of known) if (pattern.test(action)) return name;
  return "native";
}

function pickPrimaryForm(forms: AnalyzedForm[]): AnalyzedForm | null {
  const usable = forms.filter((form) => form.type !== "search" && form.type !== "login");
  return (
    usable.find((form) => form.visible && form.field_count > 0) ||
    usable.find((form) => form.visible) ||
    usable[0] ||
    null
  );
}

function dedupeIntegrations(integrations: FormIntegration[]): FormIntegration[] {
  const seen = new Set<string>();
  const out: FormIntegration[] = [];
  for (const integration of integrations) {
    const key = `${integration.provider}|${integration.src || integration.technology}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(integration);
  }
  return out;
}

/* ---------------------------- Navigation ---------------------------- */

function analyzeNavigation(record: PageRecord): PageAnalysis["navigation"] {
  let pageHost: string | null = null;
  try {
    pageHost = new URL(record.url).hostname.replace(/^www\./, "");
  } catch {
    pageHost = null;
  }

  const items = record.links.slice(0, 200).map((link) => {
    const destination = classifyDestination(link.href, record.url);
    return {
      text: link.text.slice(0, 120),
      href: destination.href,
      scope: link.in_nav ? ("nav" as const) : ("body" as const),
      external: destination.kind === "external",
    };
  });

  const externalHosts = unique(
    record.links
      .map((link) => {
        try {
          const host = new URL(link.href || "", record.url).hostname.replace(/^www\./, "");
          return pageHost && host === pageHost ? null : host;
        } catch {
          return null;
        }
      })
      .filter((host): host is string => Boolean(host)),
  );

  return {
    total_links: record.links.length,
    internal_links: items.filter((item) => !item.external && item.href).length,
    external_links: items.filter((item) => item.external).length,
    nav_links: record.links.filter((link) => link.in_nav && link.visible).length,
    anchor_links: items.filter((item) => item.href?.includes("#")).length,
    external_hosts: externalHosts,
    has_site_navigation: record.links.some((link) => link.in_nav && link.visible),
    items,
  };
}

/* --------------------------- Confirmation --------------------------- */

export function analyzeConfirmation(record: PageRecord): NonNullable<PageAnalysis["confirmation_details"]> {
  const embedded = embeddedText(record);
  const text = `${record.visible_text}\n${embedded}`;
  const evidence = [...(record.confirmation?.evidence || [])];
  for (const frame of record.embedded_text || []) {
    evidence.push(`embed ${frame.url}: ${frame.text.slice(0, 200)}`);
  }

  const nextSteps = record.paragraphs
    .filter((paragraph) => NEXT_STEP_TEXT.test(paragraph.text))
    .slice(0, 10)
    .map((paragraph) => paragraph.text.slice(0, 300));

  const upsells = unique([
    ...record.paragraphs.filter((paragraph) => UPSELL_TEXT.test(paragraph.text)).map((p) => p.text.slice(0, 240)),
    ...(record.one_time_offer?.detected ? [record.one_time_offer.product_name || "one-time offer detected"] : []),
  ]).slice(0, 8);

  return {
    is_confirmation_page: true,
    confirmation_message:
      record.confirmation?.confirmation_message ||
      record.headings.find((heading) => /thank|confirmed|scheduled|you'?re (in|all set)/i.test(heading.text))?.text ||
      embedded.match(BOOKED_LINE)?.[0]?.trim() ||
      null,
    next_steps: nextSteps.length ? nextSteps : record.confirmation?.next_step_instructions || [],
    appointment: extractAppointment(record),
    upsells,
    has_preparation_content:
      Boolean(record.confirmation?.has_preparation_instructions) || /come prepared|before (the|your) call/i.test(text),
    has_educational_content: Boolean(record.confirmation?.has_educational_content) || record.videos.length > 0,
    evidence,
  };
}

export function extractAppointment(record: PageRecord): AppointmentDetails {
  const text = `${record.visible_text} ${embeddedText(record)}`.replace(/\s+/g, " ");
  const raw: string[] = [];

  const dateMatch = text.match(DATE_TEXT) || text.match(DATE_NUMERIC);
  const timeMatch = text.match(TIME_TEXT);
  const timezoneMatch = text.match(TIMEZONE_TEXT);
  const durationMatch = text.match(DURATION_TEXT);

  if (dateMatch) raw.push(`date text: ${dateMatch[0]}`);
  if (timeMatch) raw.push(`time text: ${timeMatch[0]}`);
  if (timezoneMatch) raw.push(`timezone text: ${timezoneMatch[0]}`);

  const meetingLink = record.links.find((link) => link.href && MEETING_LINK.test(link.href))?.href || null;
  const calendarLinks = unique(
    record.links
      .filter((link) => (link.href && CALENDAR_LINK.test(link.href)) || /add to calendar/i.test(link.text))
      .map((link) => link.href)
      .filter((href): href is string => Boolean(href)),
  );

  const inviteeUrl = /calendly\.com\/.+\/invitees\//i.test(record.url) ? record.url : null;
  const provider = schedulerProvider(record.url) || detectProviderFromIframes(record);
  const host = text.match(MEETING_HOST)?.[1]?.replace(/[.,;:]+$/, "") || null;

  const detected = Boolean((dateMatch && timeMatch) || meetingLink || calendarLinks.length || inviteeUrl);

  return {
    detected,
    provider,
    date_text: dateMatch?.[0] ?? null,
    time_text: timeMatch?.[0] ?? null,
    timezone: timezoneMatch?.[0] ?? null,
    duration: durationMatch?.[0] ?? null,
    host,
    meeting_link: meetingLink,
    add_to_calendar_links: calendarLinks,
    invitee_url: inviteeUrl,
    raw_evidence: raw,
  };
}

function embeddedText(record: PageRecord): string {
  return (record.embedded_text || []).map((frame) => frame.text).join("\n");
}

function detectProviderFromIframes(record: PageRecord): string | null {
  for (const iframe of record.iframes) {
    const provider = schedulerProvider(iframe.src);
    if (provider) return provider;
  }
  for (const iframe of record.iframes) {
    if (isCalendarEmbedSrc(iframe.src)) return embedProvider(iframe.src);
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}
