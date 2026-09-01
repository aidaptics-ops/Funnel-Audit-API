/**
 * The section that refuses to interpret.
 *
 * Every other builder in this directory answers a question: is there a VSL, is
 * the offer clear, does the page have a credible guarantee. Each answer is a
 * judgement, and each judgement throws away the evidence it was made from. That
 * is fine while the question is one this service already knows to ask, and
 * useless the moment it is not - nothing here has ever heard of the page
 * builder that will ship next month.
 *
 * So this section carries the observations themselves, unlabelled. It reports
 * that an iframe points at a host, that a global called Calendly is defined,
 * that a form posts to a domain; it never says the page books calls. A reader
 * with a wider vocabulary than this code makes that call, and can make it about
 * services nobody here named.
 *
 * The one thing it does assert is where it stopped looking. Every capped or
 * filtered collection ships with its total and a truncation flag, and the
 * ledger row behind it is repeated in `completeness`, because a list cut short
 * by a cap and a page that genuinely has none of the thing look identical once
 * the evidence leaves this process.
 */

import type { CapturedCollection, CompletenessLedger } from "../evidence/completeness.js";
import type { RawHtml } from "../../pipeline/raw_html.js";
import type { CaptureResult } from "../../pipeline/capture.js";
import type {
  Capped,
  LinkRelEntry,
  MetaEntry,
  RawButtonEntry,
  RawDocumentHiddenInputEntry,
  RawEmbedEntry,
  RawEvidenceSection,
  RawFormEntry,
  RawFormFieldEntry,
  RawHeadingEntry,
  RawHiddenInputEntry,
  RawImageEntry,
  RawLinkEntry,
  RawScriptEntry,
  RawTextEntry,
} from "../landing_types.js";
import type {
  DomSnapshot,
  EmbedRecord,
  FoldPosition,
  HiddenInputRecord,
  ImageRecord,
  LinkRelRecord,
  MetaTagRecord,
  RawFormSnapshot,
} from "../../types/index.js";

/**
 * The caps the snapshot collectors apply. They are declared per-collection in
 * the ledger, which is the authority; these are the fallback for a snapshot
 * that predates the ledger (a synthetic capture in a test, say) so a `cap`
 * field is never a lie about a limit that does exist.
 */
const FALLBACK_CAP: Record<string, number> = {
  meta_all: 300,
  links_rel: 200,
  paragraphs: 1000,
  links: 1200,
  buttons: 800,
  images: 200,
  images_all: 600,
  scripts: 600,
  embeds: 400,
  hidden_inputs: 400,
};

/** What a capture that never got its markup reports, rather than undefined. */
const NO_HTML: RawHtml = {
  captured: false,
  sha256: null,
  bytes: 0,
  truncated: false,
  head: "",
  body_skeleton: null,
  note: "The rendered markup was not captured.",
};

/**
 * Assembles the unjudged section, and records into `ledger` the collections
 * whose caps live outside the DOM snapshot - the request monitor's, which the
 * browser-side collectors never see.
 *
 * The ledger is passed in rather than created here so that one object carries
 * every row from every layer of the capture: a caller reading `completeness`
 * gets the DOM collectors and the network monitor in the same list.
 */
export function buildRawEvidence(capture: CaptureResult, ledger: CompletenessLedger): RawEvidenceSection {
  const snapshot = capture.snapshot ?? ({} as DomSnapshot);

  // The monitor caps its retained arrays and counts what it dropped. Those
  // counts never reach the browser-side ledger, so they are declared here.
  ledger.record(
    "console_errors",
    capture.console_errors?.length ?? 0,
    capture.console_error_total ?? capture.console_errors?.length ?? 0,
    MONITOR_CAP,
  );
  ledger.record(
    "page_errors",
    capture.page_errors?.length ?? 0,
    capture.page_error_total ?? capture.page_errors?.length ?? 0,
    MONITOR_CAP,
  );
  // Failures are deduplicated by url+status before the cap applies, so
  // `captured` counts distinct failures and `total` counts every occurrence.
  ledger.record(
    "failed_requests",
    capture.failed_requests?.length ?? 0,
    capture.failed_request_total ?? capture.failed_requests?.length ?? 0,
    MONITOR_CAP,
  );
  // The markup is one value, not a collection, but it is capped per section and
  // a reader must not treat a truncated body as the whole document.
  const html = capture.raw_html ?? NO_HTML;
  ledger.record("raw_html", html.captured && !html.truncated ? 1 : 0, 1, null);

  const visibleText = snapshot.visible_text ?? "";
  const textRow = ledger.entries().find((entry) => entry.field === "visible_text");

  return {
    html,
    title: snapshot.title ?? "",
    url: {
      requested: capture.requested_url ?? "",
      final: capture.final_url ?? snapshot.url ?? "",
      redirect_chain: capture.redirect_chain ?? [],
      http_status: capture.http_status ?? null,
      content_type: capture.content_type ?? null,
    },
    meta: cappedFrom<MetaTagRecord, MetaEntry>(snapshot.meta_all, "meta_all", (tag) => ({
      name: tag.name ?? null,
      property: tag.property ?? null,
      http_equiv: tag.http_equiv ?? null,
      content: tag.content ?? null,
    })),
    charset: snapshot.charset ?? null,
    links_rel: cappedFrom<LinkRelRecord, LinkRelEntry>(snapshot.links_rel, "links_rel", (link) => ({
      rel: link.rel ?? null,
      href: link.href ?? null,
      type: link.type ?? null,
    })),
    visible_text: {
      text: visibleText,
      // The count the page held, not the count that survived the cap.
      characters: Math.max(textRow?.total ?? 0, visibleText.length),
      truncated: textRow ? !textRow.complete : false,
    },
    headings: (snapshot.headings ?? []).map(
      (heading): RawHeadingEntry => ({
        level: heading.level,
        text: heading.text,
        visible: heading.visible,
        position: heading.position,
        y: heading.y,
      }),
    ),
    paragraphs: cappedList<RawTextEntry>(
      (snapshot.paragraphs ?? []).map((block) => ({
        text: block.text,
        visible: block.visible,
        position: block.position,
        y: block.y,
      })),
      "paragraphs",
    ),
    links: cappedList<RawLinkEntry>(
      (snapshot.links ?? []).map((link) => ({
        text: link.text,
        href: link.href,
        host: hostOf(link.href),
        visible: link.visible,
        position: link.position,
        in_nav: link.in_nav,
        in_footer: link.in_footer,
        x: link.x,
        y: link.y,
      })),
      "links",
    ),
    buttons: cappedList<RawButtonEntry>(
      (snapshot.buttons ?? []).map((button) => ({
        text: button.text,
        tag: button.tag,
        type: button.type,
        href: button.href,
        visible: button.visible,
        position: button.position,
        x: button.x,
        y: button.y,
        selector: button.selector,
      })),
      "buttons",
    ),
    // The unfiltered collection when the snapshot carries it: `images` is the
    // judged list, and the 20px filter behind it would read here as a page
    // with no tracking pixel on it.
    images: imagesOf(snapshot),
    scripts: cappedList<RawScriptEntry>(
      (snapshot.scripts ?? []).map((script) => ({
        src: script.src,
        host: script.host,
        inline_snippet: script.inline_snippet,
      })),
      "scripts",
    ),
    iframes_embeds: embedsOf(snapshot),
    forms: formsOf(snapshot),
    // Straight from the document-wide collection the ledger counts, so every
    // hidden input the `hidden_inputs` row claims is one a reader can find.
    hidden_inputs: cappedFrom<HiddenInputRecord, RawDocumentHiddenInputEntry>(
      snapshot.hidden_inputs,
      "hidden_inputs",
      (input) => ({
        name: input.name,
        id: input.id,
        value_present: input.value_present,
        form_selector: input.form_selector,
      }),
    ),
    json_ld: snapshot.json_ld ?? [],
    window_globals_present: snapshot.window_globals_present ?? [],
    console_errors: (capture.console_errors ?? []).map((error) => ({
      text: error.text,
      source: error.source,
    })),
    page_errors: capture.page_errors ?? [],
    failed_requests: (capture.failed_requests ?? []).map((request) => ({
      url: request.url,
      status: request.status,
      reason: request.reason,
      occurrences: request.occurrences,
    })),
    request_count: capture.request_count ?? 0,
    viewport: snapshot.viewport ?? { width: 0, height: 0, scroll_width: 0, scroll_height: 0 },
    body_overflow_x: snapshot.body_overflow_x ?? false,
    completeness: ledger.entries(),
  };

  /* ---- closures over the ledger, so every cap reported here is the real one ---- */

  /** Re-wraps a collector's own envelope, keeping its counts. */
  function cappedFrom<S, T>(
    collection: CapturedCollection<S> | undefined,
    field: string,
    map: (item: S) => T,
  ): Capped<T> {
    if (!collection) return cappedList<T>([], field);
    return {
      items: collection.items.map(map),
      total: Math.max(collection.total, collection.items.length),
      truncated: collection.truncated,
      cap: collection.cap ?? FALLBACK_CAP[field] ?? collection.items.length,
    };
  }

  /**
   * Wraps a plain array using the ledger's row for it. The snapshot's arrays
   * carry no counts of their own, so the ledger is the only place that knows
   * how many the page held.
   */
  function cappedList<T>(items: T[], field: string): Capped<T> {
    const row = ledger.entries().find((entry) => entry.field === field);
    const total = Math.max(row?.total ?? items.length, items.length);
    return {
      items,
      total,
      truncated: total > items.length,
      cap: row?.cap ?? FALLBACK_CAP[field] ?? items.length,
    };
  }

  function imagesOf(source: DomSnapshot): Capped<RawImageEntry> {
    if (source.images_all) {
      return cappedFrom<ImageRecord, RawImageEntry>(source.images_all, "images_all", toImageEntry);
    }
    // A snapshot from before the unfiltered collection existed carries only the
    // judged list, whose ledger row already admits what the filter removed.
    return cappedList<RawImageEntry>((source.images ?? []).map(toImageEntry), "images");
  }

  function embedsOf(source: DomSnapshot): Capped<RawEmbedEntry> {
    if (source.embeds) {
      return cappedFrom<EmbedRecord, RawEmbedEntry>(source.embeds, "embeds", (embed) => ({
        tag: embed.tag,
        src: embed.src,
        host: hostOf(embed.src),
        title: embed.title,
        name: embed.name,
        id: embed.id,
        class_name: embed.class_name,
        allow: embed.allow,
        sandbox: embed.sandbox,
        loading: embed.loading,
        visible: embed.visible,
        position: embed.position,
        width: embed.width,
        height: embed.height,
        y: embed.y,
        inspectable: embed.inspectable,
      }));
    }

    // A snapshot from before `embeds` existed still has `iframes`, which is the
    // same evidence minus the attributes. Reporting it beats reporting nothing.
    const fallback = (source.iframes ?? []).map(
      (frame): RawEmbedEntry => ({
        tag: "iframe",
        src: frame.src,
        host: hostOf(frame.src),
        title: frame.title,
        name: null,
        id: null,
        class_name: null,
        allow: null,
        sandbox: null,
        loading: null,
        visible: frame.visible,
        position: frame.position,
        width: frame.width ?? 0,
        height: frame.height ?? 0,
        y: 0,
        inspectable: frame.inspectable,
      }),
    );
    return cappedList<RawEmbedEntry>(fallback, "iframes");
  }
}

/** The request monitor's retention ceiling, per array. Mirrors RequestMonitor. */
const MONITOR_CAP = 200;

function toImageEntry(image: ImageRecord): RawImageEntry {
  return {
    src: image.src,
    alt: image.alt,
    title: image.title ?? null,
    srcset: image.srcset ?? null,
    sizes: image.sizes ?? null,
    loading: image.loading ?? null,
    id: image.id ?? null,
    class_name: image.class_name ?? null,
    width: image.width,
    height: image.height,
    natural_width: image.natural_width ?? null,
    natural_height: image.natural_height ?? null,
    visible: image.visible,
    position: image.position,
    // An older snapshot dropped everything under 20px, so anything it kept
    // cleared the threshold by construction.
    meets_size_threshold: image.meets_size_threshold ?? true,
  };
}

/**
 * Every form the page declared, with its hidden inputs reattached.
 *
 * Nothing is dropped here. The `forms` section filters to the forms it judges
 * conversion-relevant, which loses the login form that tells you the funnel
 * sells a membership and the search box that tells you this is a content site.
 */
function formsOf(snapshot: DomSnapshot): RawFormEntry[] {
  const hidden = snapshot.hidden_inputs?.items ?? [];
  const forms = snapshot.forms ?? [];
  const foldY = snapshot.viewport?.height || 900;

  return forms.map((form, index) => {
    const bySelector = hidden.filter(
      (input: HiddenInputRecord) => form.selector !== null && input.form_selector === form.selector,
    );
    // Hidden inputs outside any form belong to no form record; they are
    // attached to the only form when there is exactly one, and otherwise left
    // in the snapshot rather than guessed at.
    const orphans =
      forms.length === 1 ? hidden.filter((input: HiddenInputRecord) => input.form_selector === null) : [];

    return {
      index,
      selector: form.selector,
      name: form.name ?? null,
      id: form.id ?? null,
      action: form.action,
      action_host: hostOf(form.action),
      method: form.method,
      visible: form.visible,
      position: foldFrom(form, foldY),
      y: form.y,
      in_modal: form.in_modal ?? false,
      heading_near: form.heading_near,
      submit_text: form.submit_text,
      field_count: form.fields.length,
      fields: form.fields.map(
        (field): RawFormFieldEntry => ({
          tag: field.tag ?? tagFromType(field.type),
          type: field.type,
          name: field.name,
          id: field.id,
          placeholder: field.placeholder,
          label: field.label,
          required: field.required,
          autocomplete: field.autocomplete,
          options: field.options,
          checked: field.checked,
          value_present: field.value_present,
          selector: field.selector,
        }),
      ),
      hidden_inputs: [...bySelector, ...orphans].map(
        (input): RawHiddenInputEntry => ({
          name: input.name,
          id: input.id,
          value_present: input.value_present,
        }),
      ),
      embedded_iframes: (form.embedded_iframes ?? []).map((frame) => ({
        tag: frame.tag,
        src: frame.src,
        host: hostOf(frame.src),
        title: frame.title,
      })),
    };
  });
}

/** The snapshot records a form's y but not its fold; the viewport decides it. */
function foldFrom(form: RawFormSnapshot, foldY: number): FoldPosition {
  if (!form.visible) return "unknown";
  return form.y < foldY ? "above_fold" : "below_fold";
}

/** Only for a snapshot that predates the field collector reporting its tag. */
function tagFromType(type: string): string {
  if (type === "select" || type === "textarea") return type;
  return "input";
}

/**
 * The host as written. Deliberately no vendor lookup: "calendly.com" is the
 * evidence, and calling it a booking tool is the reader's job, not this file's.
 */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
