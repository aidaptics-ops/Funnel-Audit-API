import type { CaptureResult } from "../../pipeline/capture.js";
import { isCalendarEmbedSrc, isFormEmbedSrc } from "../../extraction/embed_hosts.js";
import type { PageType } from "../../types/index.js";
import {
  detected,
  unknown,
  type BusinessIdentity,
  type ConversionGoal,
  type Determination,
  type FunnelSection,
  type FunnelType,
} from "../landing_types.js";

/** Multi-part public suffixes common enough to matter for root-domain grouping. */
const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "co.za",
  "co.in",
  "co.jp",
  "com.mx",
  "com.sg",
]);

const SOCIAL_PLATFORMS: Array<{ platform: string; re: RegExp }> = [
  { platform: "facebook", re: /(?:^|\.)facebook\.com$|(?:^|\.)fb\.com$/i },
  { platform: "instagram", re: /(?:^|\.)instagram\.com$/i },
  { platform: "linkedin", re: /(?:^|\.)linkedin\.com$/i },
  { platform: "x", re: /(?:^|\.)(?:twitter|x)\.com$/i },
  { platform: "youtube", re: /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i },
  { platform: "tiktok", re: /(?:^|\.)tiktok\.com$/i },
  { platform: "pinterest", re: /(?:^|\.)pinterest\.[a-z.]+$/i },
  { platform: "threads", re: /(?:^|\.)threads\.net$/i },
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;
const STREET_RE =
  /\b\d{1,5}[a-z]?\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|way|court|ct|place|pl|suite|ste|floor)\b/i;
const COPYRIGHT_RE = /(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?\s*([^.|·•\n]{2,60})/i;

export function buildFunnel(capture: CaptureResult): FunnelSection {
  const snapshot = capture.snapshot;
  const record = capture.record;
  const host = hostOf(capture.final_url);
  const rootDomain = rootDomainOf(host);

  const redirectChain = capture.redirect_chain;
  const uniqueHops = redirectChain.filter(
    (hop, index) => index === 0 || hop.url !== redirectChain[index - 1]?.url,
  );

  return {
    requested_url: capture.requested_url,
    final_url: capture.final_url,
    domain: host,
    root_domain: rootDomain,
    redirected: uniqueHops.length > 1,
    redirect_chain: redirectChain,
    funnel_type: classifyFunnelType(capture),
    page_type_classification: {
      page_type: record.page_type,
      confidence: record.classification_confidence,
      evidence: record.classification_evidence,
    },
    brand_name: detectBrandName(capture, host),
    primary_conversion_goal: detectConversionGoal(capture),
    business_identity: extractBusinessIdentity(capture, host, rootDomain),
  };
}

/* ----------------------------- funnel type ----------------------------- */

const PAGE_TYPE_TO_FUNNEL: Partial<Record<PageType, FunnelType>> = {
  vsl: "vsl",
  optin: "optin",
  webinar_registration: "webinar_registration",
  application: "application",
  sales_page: "sales_page",
  booking: "booking",
  calendar: "booking",
  checkout: "checkout",
};

/**
 * Built only from structural observations, each of which is a different fact
 * about the page. The page classifier is deliberately NOT counted as a signal:
 * it scores "vsl" from the very observation ("a video above the fold") that
 * would otherwise corroborate it, so counting both was one fact wearing two
 * hats. The classifier only raises confidence once the structure already agrees.
 */
function classifyFunnelType(capture: CaptureResult): Determination<FunnelType> {
  const record = capture.record;
  const snapshot = capture.snapshot;
  const text = (snapshot.visible_text ?? "").toLowerCase();
  const candidate = PAGE_TYPE_TO_FUNNEL[record.page_type];

  const forms = record.forms.filter((form) => form.type !== "search" && form.type !== "login");
  const emailShortForm = forms.find(
    (form) => form.field_count > 0 && form.field_count <= 3 && form.fields.some((f) => f.purpose === "email"),
  );
  const longForm = forms.find((form) => form.field_count >= 5);
  const paymentForm = forms.find((form) => form.fields.some((field) => field.purpose === "payment"));
  const schedulerEmbed = record.iframes.find((frame) => isCalendarEmbedSrc(frame.src));
  const schedulerCta = primarySchedulerCta(capture);
  const videos = record.videos;
  const videoAboveFold = videos.find((video) => video.position === "above_fold");
  const navLinks = snapshot.links.filter((link) => link.in_nav && link.visible).length;

  const signals: Array<{ type: FunnelType; note: string }> = [];

  // --- vsl: the page is built around one video, not merely showing one ---
  if (videoAboveFold) signals.push({ type: "vsl", note: "a video renders above the fold" });
  if (videos.length === 1 && videoAboveFold) {
    signals.push({ type: "vsl", note: "exactly one video carries the page" });
  }
  if (/\b(watch|press play|video below|turn (your )?sound on)\b/.test(text)) {
    signals.push({ type: "vsl", note: "the copy directs the visitor to watch" });
  }
  if (videoAboveFold && navLinks <= 3) {
    signals.push({ type: "vsl", note: `navigation is stripped to ${navLinks} link(s)` });
  }

  // --- booking ---
  if (schedulerEmbed) {
    signals.push({ type: "booking", note: `a scheduler is embedded (${schedulerEmbed.src ?? "iframe"})` });
  }
  if (schedulerCta) {
    signals.push({ type: "booking", note: `a visible CTA points at a scheduler: "${schedulerCta}"` });
  }
  if (/\b(select a (day|date)|pick a time|available times?)\b/.test(text)) {
    signals.push({ type: "booking", note: "time-picker wording is on the page" });
  }

  // --- checkout ---
  if (paymentForm) signals.push({ type: "checkout", note: "a form asks for payment details" });
  if (/\b(order summary|complete (my |your )?purchase|pay now|billing address)\b/.test(text)) {
    signals.push({ type: "checkout", note: "checkout wording is on the page" });
  }

  // --- application ---
  if (longForm) {
    signals.push({ type: "application", note: `a form asks ${longForm.field_count} questions` });
  }
  if (/\b(apply|application|qualify|see if you.{0,12}fit)\b/.test(text)) {
    signals.push({ type: "application", note: "application wording is on the page" });
  }

  // --- webinar / lead magnet / opt-in ---
  const webinarLanguage = /\b(webinar|masterclass|live training|live workshop)\b/.test(text);
  // Bare "download" appears in every app-store footer, so require the phrase to
  // name the thing being downloaded.
  const downloadLanguage =
    /\b(free (guide|pdf|checklist|template|cheat ?sheet|report|ebook|swipe file)|download the (guide|pdf|checklist|template|report|ebook))\b/.test(
      text,
    );
  if (emailShortForm) {
    signals.push({
      type: webinarLanguage ? "webinar_registration" : downloadLanguage ? "lead_magnet" : "optin",
      note: `a ${emailShortForm.field_count}-field email capture form is present`,
    });
  }
  if (emailShortForm && webinarLanguage) {
    signals.push({ type: "webinar_registration", note: "webinar wording accompanies the registration form" });
  }
  if (emailShortForm && downloadLanguage) {
    signals.push({ type: "lead_magnet", note: "the copy names a downloadable asset" });
  }
  if (emailShortForm && !webinarLanguage && !downloadLanguage && /\b(subscribe|join|get access|sign up)\b/.test(text)) {
    signals.push({ type: "optin", note: "opt-in wording accompanies the email form" });
  }

  // --- sales page ---
  if (record.pricing.length > 0 && /\b(buy now|enroll|add to cart|get instant access)\b/.test(text)) {
    signals.push({ type: "sales_page", note: "a stated price sits beside purchase wording" });
  }

  if (!signals.length) return unknown("No structural signal identified the funnel type");

  const byType = new Map<FunnelType, string[]>();
  for (const signal of signals) {
    byType.set(signal.type, [...(byType.get(signal.type) ?? []), signal.note]);
  }

  const ranked = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  const [type, notes] = ranked[0];
  if (notes.length < 2) {
    return unknown(
      `Only one structural signal (${notes[0]}) pointed at a funnel type; two independent signals are required`,
    );
  }

  const classifierAgrees = candidate === type;
  const confidence = Math.min(
    0.9,
    0.45 + 0.1 * notes.length + (classifierAgrees ? 0.1 : 0) - (ranked[1] && ranked[1][1].length === notes.length ? 0.1 : 0),
  );
  const evidence = classifierAgrees
    ? [...notes, `the page classifier independently scored ${record.page_type} (${record.classification_confidence})`]
    : notes;

  return detected(type, confidence, evidence);
}

/**
 * A scheduler link in the footer is not what the page is for. Only a visible
 * CTA outside the footer counts as the page's booking path.
 */
function primarySchedulerCta(capture: CaptureResult): string | null {
  const footerHrefs = new Set(
    capture.snapshot.links.filter((link) => link.in_footer).map((link) => link.href ?? ""),
  );
  const cta = capture.record.ctas.find(
    (item) => item.visible && isCalendarEmbedSrc(item.href) && !footerHrefs.has(item.href ?? ""),
  );
  return cta?.text?.trim() || null;
}

/* ------------------------------ brand name ------------------------------ */

function detectBrandName(capture: CaptureResult, host: string): Determination<string> {
  const snapshot = capture.snapshot;

  const fromSchema = organizationNames(snapshot.json_ld)[0];
  if (fromSchema) {
    return detected(fromSchema, 0.9, [`JSON-LD organization name: "${fromSchema}"`]);
  }

  const siteName = snapshot.meta.og_site_name?.trim();
  if (siteName) return detected(siteName, 0.85, [`og:site_name: "${siteName}"`]);

  // The copyright LINE is not the brand NAME: "RealSide Real Estate, 2026"
  // names the holder and the year. Keep the raw line in business_identity and
  // use a cleaned candidate here.
  const copyrightLine = copyrightHolders(capture)[0];
  const copyright = copyrightLine ? cleanBrandCandidate(copyrightLine) : null;

  // Only the alt attribute, and only above the fold: a client-logo strip further
  // down is full of images whose src contains "logo" and whose alt is a
  // customer's name, which would report the customer as the brand.
  const logoImages = snapshot.images.filter(
    (image) => image.position === "above_fold" && /\blogos?\b/i.test(image.alt ?? ""),
  );
  const logoAlt = logoImages.length === 1 ? logoImages[0].alt : null;
  const cleanedLogoAlt = logoAlt?.replace(/\s*logo\s*$/i, "").trim();
  if (cleanedLogoAlt && cleanedLogoAlt.length >= 2) {
    return detected(cleanedLogoAlt, 0.6, [`logo image alt text: "${logoAlt}"`]);
  }

  // "Brand | Page" and "Page | Brand" are both common, so a title segment is
  // only a brand when something else on the page says the same thing.
  const corroborated = brandFromTitle(snapshot.title, [host, snapshot.meta.og_site_name ?? "", copyright ?? ""]);
  if (corroborated) {
    return detected(corroborated.value, 0.65, [
      `title segment "${corroborated.value}" corroborated by ${corroborated.source}`,
    ]);
  }

  if (copyright) {
    return detected(copyright, 0.5, [
      `copyright line: "${copyrightLine}"`,
      copyright === copyrightLine ? "used verbatim" : `year and boilerplate stripped to "${copyright}"`,
    ]);
  }

  return unknown(`No brand name was stated on the page (host is ${host})`);
}

/**
 * Returns a title segment only when another source on the page names the same
 * thing, so "Book a Free Strategy Call" never becomes the brand just because it
 * happened to sit last in the title.
 */
function brandFromTitle(
  title: string,
  corroborators: string[],
): { value: string; source: string } | null {
  const parts = (title || "")
    // "Audit- Joey Battista" is as common as "Audit - Joey Battista"; a dash
    // followed by a space separates segments, a hyphen inside a word does not.
    .split(/\s*[|–—]\s*|\s+-\s+|(?<=\w)-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const sources = [
    { label: "the hostname", value: corroborators[0] ?? "" },
    { label: "og:site_name", value: corroborators[1] ?? "" },
    { label: "the copyright line", value: corroborators[2] ?? "" },
  ].filter((source) => source.value.trim().length > 1);

  for (const part of [parts[parts.length - 1], parts[0]]) {
    if (part.length < 2 || part.length > 60) continue;
    const compact = compactWords(part);
    if (compact.length < 3) continue;
    const source = sources.find((candidate) => compactWords(candidate.value).includes(compact));
    if (source) return { value: part, source: source.label };
  }

  return null;
}

/** Lowercased and stripped of everything but letters and digits, for matching. */
function compactWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* --------------------------- conversion goal --------------------------- */

function detectConversionGoal(capture: CaptureResult): Determination<ConversionGoal> {
  const record = capture.record;
  const text = (capture.snapshot.visible_text ?? "").toLowerCase();
  const ctaText = record.ctas.map((cta) => cta.text.toLowerCase()).join(" | ");
  const evidence: string[] = [];

  const forms = record.forms.filter((form) => form.type !== "search" && form.type !== "login");
  const schedulerEmbed = record.iframes.find((frame) => isCalendarEmbedSrc(frame.src));
  const schedulerCta = primarySchedulerCta(capture);
  const paymentForm = forms.some((form) => form.fields.some((field) => field.purpose === "payment"));

  if (schedulerEmbed || schedulerCta) {
    if (schedulerEmbed) evidence.push(`a scheduler is embedded (${schedulerEmbed.src ?? "iframe"})`);
    if (schedulerCta) evidence.push(`a visible CTA points at a scheduler: "${schedulerCta}"`);
    if (/\bbook|schedule|call\b/.test(ctaText)) {
      evidence.push(`CTA wording: "${firstCta(record.ctas, /book|schedule|call/i)}"`);
    }
    // An embed is the page's purpose; a single link is weaker evidence.
    const confidence = schedulerEmbed ? 0.85 : evidence.length > 1 ? 0.7 : 0.6;
    return detected("book_a_call", confidence, evidence);
  }

  if (paymentForm || /\b(order summary|credit card|pay now|complete (my |your )?purchase)\b/.test(text)) {
    evidence.push("payment fields or checkout wording are present");
    return detected("purchase", 0.8, evidence);
  }

  const longForm = forms.find((form) => form.field_count >= 5);
  if (longForm) {
    evidence.push(`an application-length form (${longForm.field_count} fields) is present`);
    if (/\b(apply|application|qualify)\b/.test(`${ctaText} ${text}`)) {
      evidence.push("application wording on the page");
      return detected("submit_application", 0.75, evidence);
    }
    // A long form is definitely not a one-field opt-in, so stop here rather than
    // falling through and reporting the weaker goal.
    return unknown(
      `A ${longForm.field_count}-field form is present but the page never says what submitting it does`,
    );
  }

  const emailForm = forms.find(
    (form) => form.field_count > 0 && form.fields.some((field) => field.purpose === "email"),
  );
  if (emailForm) {
    if (/\bwebinar|masterclass|live training\b/.test(text)) {
      return detected("register_for_webinar", 0.75, [
        "a registration form is present",
        "webinar wording on the page",
      ]);
    }
    // Bare "download" appears in app-store footers; require the named asset.
    if (
      /\b(free (guide|pdf|checklist|template|cheat ?sheet|report|ebook)|download the (guide|pdf|checklist|template|report|ebook))\b/.test(
        text,
      )
    ) {
      return detected("download_lead_magnet", 0.7, [
        "a short email form is present",
        "the copy names a downloadable asset",
      ]);
    }
    return detected("opt_in", 0.65, [`an email capture form with ${emailForm.field_count} field(s) is present`]);
  }

  if (/\bcontact us\b/.test(ctaText) && forms.length > 0) {
    return detected("contact", 0.6, ["a contact form and contact CTA wording are present"]);
  }

  return unknown("The page exposes no form, scheduler or purchase path");
}

function firstCta(ctas: CaptureResult["record"]["ctas"], pattern: RegExp): string {
  return ctas.find((cta) => pattern.test(cta.text))?.text ?? "";
}

/* --------------------------- business identity -------------------------- */

function extractBusinessIdentity(
  capture: CaptureResult,
  host: string,
  rootDomain: string,
): BusinessIdentity {
  const snapshot = capture.snapshot;
  const brand = detectBrandName(capture, host);

  const emails = new Set<string>();
  const phones = new Set<string>();
  const socials = new Map<string, { platform: string; url: string }>();

  for (const link of snapshot.links) {
    const href = link.href ?? "";
    if (/^mailto:/i.test(href)) {
      const address = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (address.includes("@")) emails.add(address);
      continue;
    }
    if (/^tel:/i.test(href)) {
      const number = href.replace(/^tel:/i, "").trim();
      if (number) phones.add(number);
      continue;
    }
    const linkHost = hostOf(href);
    const social = SOCIAL_PLATFORMS.find(({ re }) => re.test(linkHost));
    if (social) socials.set(`${social.platform}:${href}`, { platform: social.platform, url: href });
  }

  for (const match of (snapshot.visible_text ?? "").match(EMAIL_RE) ?? []) {
    emails.add(match.toLowerCase());
  }

  // Only trust free-text numbers that sit next to a phone label: bare digit runs
  // in marketing copy are prices, dates and statistics far more often than phones.
  for (const line of snapshot.visible_text.split(/\n+/)) {
    if (!/\b(phone|tel|telephone|call us|mobile|whatsapp)\b/i.test(line)) continue;
    for (const match of line.match(PHONE_RE) ?? []) {
      const digits = match.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 15) phones.add(match.trim());
    }
  }

  return {
    domain: host,
    root_domain: rootDomain,
    brand_name: brand.status === "detected" ? brand.value : null,
    brand_name_sources: brand.status === "detected" ? brand.evidence : [],
    organization_names: organizationNames(snapshot.json_ld),
    contact_emails: [...emails].slice(0, 20),
    contact_phones: [...phones].slice(0, 20),
    social_profiles: [...socials.values()].slice(0, 20),
    addresses: addresses(capture),
    copyright_holders: copyrightHolders(capture),
  };
}

function organizationNames(nodes: unknown[]): string[] {
  const names = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    const type = object["@type"];
    const types = Array.isArray(type) ? type.map(String) : typeof type === "string" ? [type] : [];
    if (types.some((value) => /Organization|LocalBusiness|Corporation|WebSite|Brand/i.test(value))) {
      const name = object.name ?? object.legalName;
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    }
    for (const value of Object.values(object)) visit(value);
  };

  nodes.forEach(visit);
  return [...names].slice(0, 10);
}

function addresses(capture: CaptureResult): string[] {
  const found = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (String(object["@type"] ?? "") === "PostalAddress") {
      const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]
        .map((key) => object[key])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (parts.length) found.add(parts.join(", "));
    }
    for (const value of Object.values(object)) visit(value);
  };

  capture.snapshot.json_ld.forEach(visit);

  for (const paragraph of capture.snapshot.paragraphs) {
    const match = paragraph.text.match(STREET_RE);
    if (match) found.add(match[0].trim());
    if (found.size >= 10) break;
  }

  return [...found].slice(0, 10);
}

function copyrightHolders(capture: CaptureResult): string[] {
  const holders = new Set<string>();
  const blocks = [
    ...capture.snapshot.paragraphs.map((paragraph) => paragraph.text),
    (capture.snapshot.visible_text ?? "").slice(-1500),
  ];

  for (const block of blocks) {
    const match = block.match(COPYRIGHT_RE);
    const holder = stripCopyrightPrefix(match?.[1] ?? "");
    if (holder.length >= 2 && !/all rights reserved/i.test(holder)) {
      holders.add(holder.replace(/[,.]?\s*all rights reserved.*$/i, "").trim());
    }
  }

  return [...holders].slice(0, 5);
}

/* --------------------------------- urls --------------------------------- */

/**
 * "Copyright © 2025 HackerFit LLC" leaves the symbol and year in front of the
 * holder, because the leading word matched before them. Peel them off.
 */
function stripCopyrightPrefix(value: string): string {
  let holder = value.replace(/\s+/g, " ").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = holder
      .replace(/^(?:copyright|copr\.?)\b\s*/i, "")
      .replace(/^(?:©|\(c\))\s*/i, "")
      .replace(/^\d{4}(?:\s*[-–]\s*\d{4})?[,\s]*/, "")
      .trim();
    if (stripped === holder) break;
    holder = stripped;
  }
  return holder;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rootDomainOf(host: string): string {
  if (!host || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/**
 * Turns a copyright line into a brand candidate: drops years, "all rights
 * reserved" boilerplate and trailing punctuation. Returns null when nothing
 * name-like survives, because a bare year is not a brand.
 */
function cleanBrandCandidate(raw: string): string | null {
  let value = raw.trim();
  value = value.replace(/\ball rights reserved\b\.?/gi, "");
  value = value.replace(/\b(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\b/g, "");
  value = value.replace(/^[\s,;:.·|•–-]+/, "").replace(/[\s,;:.·|•–-]+$/, "");
  value = value.replace(/\s{2,}/g, " ").trim();
  if (value.length < 2) return null;
  // A leftover fragment with no letters is not a name.
  if (!/[a-z]/i.test(value)) return null;
  return value;
}
