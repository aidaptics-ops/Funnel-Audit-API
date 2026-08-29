import type { CaptureResult } from "../../pipeline/capture.js";
import {
  embedProvider,
  isCalendarEmbedSrc,
  isFormEmbedSrc,
} from "../../extraction/embed_hosts.js";
import type {
  FormFieldRecord,
  FormRecord,
  IframeRecord,
  LinkRecord,
  RawFormSnapshot,
} from "../../types/index.js";
import type { FormEntry, FormFieldEntry, FormIntegrationKind } from "../landing_types.js";

const NOT_INTERACTED_NOTE =
  "This form was not interacted with: no field was filled, no control was clicked, no submission was attempted.";

/** Host suffixes that identify the platform a native form posts to. */
const PLATFORM_HOSTS: Array<{ provider: string; hosts: string[] }> = [
  { provider: "typeform", hosts: ["typeform.com"] },
  { provider: "jotform", hosts: ["jotform.com", "jotform.co", "jotformeu.com"] },
  { provider: "tally", hosts: ["tally.so"] },
  { provider: "fillout", hosts: ["fillout.com"] },
  { provider: "gohighlevel", hosts: ["leadconnectorhq.com", "msgsndr.com", "gohighlevel.com"] },
  { provider: "hubspot", hosts: ["hsforms.com", "hsforms.net", "hubspot.com", "hubapi.com", "hs-sites.com"] },
  { provider: "activecampaign", hosts: ["activehosted.com", "activecampaign.com"] },
  { provider: "convertkit", hosts: ["convertkit.com", "ck.page", "convertkit-mail.com"] },
  { provider: "mailchimp", hosts: ["list-manage.com", "mailchimp.com", "mailchi.mp"] },
  { provider: "klaviyo", hosts: ["klaviyo.com", "kmail-lists.com"] },
  { provider: "clickfunnels", hosts: ["clickfunnels.com", "myclickfunnels.com"] },
  { provider: "kajabi", hosts: ["kajabi.com", "mykajabi.com"] },
  { provider: "kartra", hosts: ["kartra.com"] },
  { provider: "systeme.io", hosts: ["systeme.io"] },
  { provider: "webflow", hosts: ["webflow.com", "webflow.io"] },
  { provider: "wordpress", hosts: ["wordpress.com"] },
];

/** WordPress form endpoints live on the site's own host, so the path is the signal. */
const WORDPRESS_PATHS = [
  "/wp-admin/admin-ajax.php",
  "/wp-comments-post.php",
  "/wp-json/contact-form-7",
  "/wp-content/",
  "/wp-json/wp/",
];

export function buildForms(capture: CaptureResult): FormEntry[] {
  const snapshot = capture.snapshot;
  const pageUrl = capture.final_url || snapshot.url;
  const pageHost = hostOf(pageUrl, null);
  const foldHeight = snapshot.viewport.height;

  const entries: FormEntry[] = [];
  const usedSnapshotForms = new Set<RawFormSnapshot>();

  for (const record of capture.record.forms) {
    if (shouldSkip(record)) continue;
    const raw = matchSnapshotForm(record, snapshot.forms, usedSnapshotForms);
    if (raw) usedSnapshotForms.add(raw);
    entries.push(fromRecord(record, raw, snapshot.iframes, pageUrl, pageHost, foldHeight));
  }

  entries.push(...fromUninspectableEmbeds(snapshot.iframes, entries, pageUrl, pageHost));
  entries.push(...fromExternalLinks(snapshot.links, entries, pageUrl, pageHost));

  return entries.map((entry, index) => ({ ...entry, index }));
}

/** Search boxes and login forms are explicitly out of scope for funnel analysis. */
function shouldSkip(record: FormRecord): boolean {
  if (record.type === "search" || record.type === "login") return true;
  const fields = record.fields;
  if (fields.length > 0 && fields.every((field) => field.type === "search" || field.purpose === "search")) {
    return true;
  }
  return false;
}

function fromRecord(
  record: FormRecord,
  raw: RawFormSnapshot | null,
  iframes: IframeRecord[],
  pageUrl: string,
  pageHost: string | null,
  foldHeight: number,
): FormEntry {
  const isEmbed = record.method === "iframe";
  const isOrphan = record.method === "unknown";
  const inModal = Boolean(raw?.in_modal);

  const integration: FormIntegrationKind = isEmbed
    ? "iframe_embed"
    : inModal
      ? "popup"
      : isOrphan
        ? "orphan_fields"
        : "native_html";

  const provider = isEmbed
    ? embedProvider(record.action) || "unknown"
    : nativeProvider(record.action, pageUrl);

  const fields = record.fields.map(toFieldEntry);
  const placeholderOnly = isEmbed && record.fields.length === 1 && record.fields[0].type === "calendar";
  const fieldsAccessible = isEmbed ? record.fields.length > 0 && !placeholderOnly : true;

  const y = isEmbed ? null : (raw?.y ?? null);
  const aboveFold = isEmbed
    ? record.position === "above_fold"
    : y !== null
      ? y < foldHeight
      : record.position === "above_fold";

  const notes: string[] = [NOT_INTERACTED_NOTE];

  if (isEmbed) {
    const host = hostOf(record.action, pageUrl);
    notes.push(
      host
        ? `Form is rendered inside a third-party iframe served by ${host}.`
        : "Form is rendered inside a third-party iframe.",
    );
    if (embedProvider(record.action) === null) {
      notes.push("The embed host does not match any form provider this analysis recognises.");
    }
    if (placeholderOnly) {
      notes.push(
        "Only a calendar time-slot picker was observed inside the embed; the individual booking fields were not listed.",
      );
    } else if (!fieldsAccessible) {
      notes.push("No fields could be listed inside the embedded frame.");
    }
    const limitation = iframes.find((frame) => frame.src === record.action)?.limitation;
    if (limitation) notes.push(`Iframe limitation reported during capture: ${quote(limitation)}`);
  }

  if (isOrphan) {
    notes.push(
      "Input elements were found outside any <form> element, so the submit destination could not be read from the DOM.",
    );
  }

  if (inModal) {
    notes.push(
      "Form markup sits inside a modal/popup container; it may only become visible after a user action that this analysis never performs.",
    );
  }

  if (!record.visible) notes.push("The form was not visible in the rendered page at capture time.");
  if (!isEmbed && !isOrphan && !record.action) {
    notes.push("The form has no action value in the DOM, so its submit destination is unknown.");
  }
  if (!raw && !isEmbed) {
    notes.push("No matching form in the DOM snapshot; position values come from the extracted record only.");
  }
  if (record.progress_indicator) {
    notes.push(`Multi-step indicator observed on the page: "${quote(record.progress_indicator)}"`);
  }
  if (record.submit_text) notes.push(`Submit control text: "${quote(record.submit_text)}"`);

  return {
    index: 0,
    provider,
    integration,
    location: {
      selector: record.selector,
      y,
      above_fold: aboveFold,
      visible: record.visible,
      in_modal: inModal,
    },
    iframe_url: isEmbed ? record.action : null,
    action: record.action,
    method: record.method,
    cta_text: record.submit_text,
    field_count: record.field_count,
    required_field_count: record.fields.filter((field) => field.required).length,
    fields,
    fields_accessible: fieldsAccessible,
    destination: destinationOf(record.action, pageUrl, pageHost, isEmbed),
    interacted: false,
    notes,
  };
}

/**
 * Form/booking iframes the embedded inspector could not read produce no FormRecord,
 * but the embed itself is still an observed form surface on the page.
 */
function fromUninspectableEmbeds(
  iframes: IframeRecord[],
  existing: FormEntry[],
  pageUrl: string,
  pageHost: string | null,
): FormEntry[] {
  const known = new Set(existing.map((entry) => entry.iframe_url).filter((url): url is string => Boolean(url)));
  const out: FormEntry[] = [];
  const seen = new Set<string>();

  for (const frame of iframes) {
    const src = frame.src;
    if (!src || known.has(src) || seen.has(src)) continue;
    if (!isFormEmbedSrc(src) && !isCalendarEmbedSrc(src)) continue;
    seen.add(src);

    const notes = [
      NOT_INTERACTED_NOTE,
      "Embedded form iframe detected on the page, but its fields could not be listed from the parent document.",
    ];
    if (frame.limitation) notes.push(`Iframe limitation reported during capture: ${quote(frame.limitation)}`);
    if (frame.title) notes.push(`Iframe title attribute: "${quote(frame.title)}"`);

    out.push({
      index: 0,
      provider: embedProvider(src) || "unknown",
      integration: "iframe_embed",
      location: {
        selector: null,
        y: null,
        above_fold: frame.position === "above_fold",
        visible: frame.visible,
        in_modal: false,
      },
      iframe_url: src,
      action: src,
      method: "iframe",
      cta_text: null,
      field_count: 0,
      required_field_count: 0,
      fields: [],
      fields_accessible: false,
      destination: destinationOf(src, pageUrl, pageHost, true),
      interacted: false,
      notes,
    });
  }

  return out;
}

/** Visible links that send the visitor to a form hosted somewhere else. */
function fromExternalLinks(
  links: LinkRecord[],
  existing: FormEntry[],
  pageUrl: string,
  pageHost: string | null,
): FormEntry[] {
  const known = new Set(
    existing.flatMap((entry) => [entry.iframe_url, entry.action].filter((url): url is string => Boolean(url))),
  );
  const out: FormEntry[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const href = link.href;
    if (!href || !link.visible) continue;
    if (!isFormEmbedSrc(href)) continue;
    if (known.has(href) || seen.has(href)) continue;
    seen.add(href);

    const host = hostOf(href, pageUrl);
    const notes = [
      NOT_INTERACTED_NOTE,
      "This is a link to a form hosted off this page; the link was never followed, so its fields are unknown.",
    ];
    if (link.text) notes.push(`Link text: "${quote(link.text)}"`);
    notes.push(`Link target: ${quote(href)}`);

    out.push({
      index: 0,
      provider: embedProvider(href) || "unknown",
      integration: "external_link",
      location: {
        selector: null,
        y: link.y,
        above_fold: link.position === "above_fold",
        visible: link.visible,
        in_modal: false,
      },
      iframe_url: null,
      action: href,
      method: null,
      cta_text: link.text || null,
      field_count: 0,
      required_field_count: 0,
      fields: [],
      fields_accessible: false,
      destination: {
        host,
        kind: host === null ? "unknown" : host === pageHost ? "same_origin" : "third_party_endpoint",
      },
      interacted: false,
      notes,
    });
  }

  return out;
}

function matchSnapshotForm(
  record: FormRecord,
  rawForms: RawFormSnapshot[],
  used: Set<RawFormSnapshot>,
): RawFormSnapshot | null {
  if (record.method === "iframe") return null;
  const bySelector =
    record.selector === null
      ? undefined
      : rawForms.find((raw) => !used.has(raw) && raw.selector === record.selector);
  if (bySelector) return bySelector;
  const byAction =
    record.action === null
      ? undefined
      : rawForms.find((raw) => !used.has(raw) && raw.action === record.action);
  return byAction ?? null;
}

function toFieldEntry(field: FormFieldRecord): FormFieldEntry {
  return {
    label: field.label,
    name: field.name,
    type: field.type,
    purpose: field.purpose,
    required: field.required,
    option_count: field.options.length,
  };
}

function nativeProvider(action: string | null, pageUrl: string): string {
  if (!action) return "unknown";
  const url = parseUrl(action, pageUrl);
  if (!url) return "unknown";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return "native";

  for (const { provider, hosts } of PLATFORM_HOSTS) {
    if (hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return provider;
  }
  const path = url.pathname.toLowerCase();
  if (WORDPRESS_PATHS.some((candidate) => path.startsWith(candidate) || path.includes(candidate))) {
    return "wordpress";
  }
  return "native";
}

function destinationOf(
  action: string | null,
  pageUrl: string,
  pageHost: string | null,
  isEmbed: boolean,
): { host: string | null; kind: string | null } {
  if (!action) return { host: null, kind: "unknown" };
  const host = hostOf(action, pageUrl);
  if (isEmbed) return { host, kind: "embed" };
  if (host === null) return { host: null, kind: "unknown" };
  return { host, kind: host === pageHost ? "same_origin" : "third_party_endpoint" };
}

function hostOf(url: string | null, base: string | null): string | null {
  const parsed = parseUrl(url, base);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return host || null;
}

function parseUrl(url: string | null, base: string | null): URL | null {
  if (!url) return null;
  try {
    return base ? new URL(url, base) : new URL(url);
  } catch {
    return null;
  }
}

function quote(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
