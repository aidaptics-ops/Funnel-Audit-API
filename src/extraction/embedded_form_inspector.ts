import type { Frame, Page } from "playwright";
import { inferFieldPurpose } from "./field_purpose.js";
import {
  embedProvider,
  isCalendarEmbedSrc,
  isFormEmbedSrc,
} from "./embed_hosts.js";
import { measureFriction } from "./form_extractor.js";
import type {
  FoldPosition,
  FormFieldRecord,
  FormKind,
  FormRecord,
  IframeRecord,
} from "../types/index.js";

const TYPEFORM_TYPES = new Set([
  "short_text",
  "long_text",
  "email",
  "phone_number",
  "number",
  "multiple_choice",
  "yes_no",
  "dropdown",
  "legal",
  "website",
  "file_upload",
  "date",
  "opinion_scale",
  "rating",
  "nps",
  "matrix",
  "ranking",
  "picture_choice",
  "contact_info",
  "calendly",
  "address",
  "payment",
  "statement",
  "group",
  "welcome_screen",
  "thankyou_screen",
]);

export interface EmbeddedInspection {
  forms: FormRecord[];
  iframeUpdates: Map<string, Partial<IframeRecord>>;
}

export async function inspectEmbeddedForms(
  page: Page,
  iframes: IframeRecord[],
  typeformPayloads: unknown[] = [],
): Promise<EmbeddedInspection> {
  const forms: FormRecord[] = [];
  const iframeUpdates = new Map<string, Partial<IframeRecord>>();

  await page
    .waitForSelector(
      'iframe[src*="typeform"], iframe[src*="calendly"], iframe[src*="cal.com"], iframe[src*="leadconnector"], iframe[src*="msgsndr"], iframe[src*="gohighlevel"], iframe[src*="jotform"]',
      {
        timeout: 4000,
      },
    )
    .catch(() => null);

  for (const record of iframes) {
    const src = record.src;
    if (!src || (!isFormEmbedSrc(src) && !isCalendarEmbedSrc(src))) continue;

    const provider = embedProvider(src) || "iframe";
    const frame = findFrame(page, src);
    if (!frame) {
      iframeUpdates.set(src, {
        inspectable: false,
        limitation: "iframe element was detected but Playwright could not attach to the frame",
      });
      continue;
    }

    try {
      await frame.evaluate(
        `globalThis.__name = globalThis.__name || function (target) { return target; };`,
      );
      await frame.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
      const extracted =
        provider === "typeform"
          ? await inspectTypeform(frame, src, record, typeformPayloads, page)
          : { form: await inspectGenericEmbed(frame, src, record, provider), limitation: null };

      if (extracted.form) {
        forms.push(extracted.form);
        iframeUpdates.set(src, {
          inspectable: true,
          limitation: null,
        });
      } else {
        iframeUpdates.set(src, {
          inspectable: true,
          limitation:
            extracted.limitation ??
            "Frame is attached and readable; schema fields were not listed in the DOM snapshot",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      iframeUpdates.set(src, {
        inspectable: false,
        limitation: `iframe inspection failed: ${message}`,
      });
    }
  }

  return { forms, iframeUpdates };
}

function findFrame(page: Page, src: string): Frame | null {
  const frames = page.frames();
  const exact = frames.find((frame) => frame.url() === src);
  if (exact) return exact;
  try {
    const host = new URL(src, page.url()).hostname;
    const idMatch = src.match(/\/to\/([^/?#]+)/);
    return (
      frames.find((frame) => {
        try {
          return new URL(frame.url()).hostname === host;
        } catch {
          return frame.url().includes(host);
        }
      }) ||
      (idMatch ? frames.find((frame) => frame.url().includes(idMatch[1])) : undefined) ||
      null
    );
  } catch {
    return frames.find((frame) => src && frame.url().includes(src.slice(0, 40))) || null;
  }
}

interface EmbedInspection {
  form: FormRecord | null;
  limitation: string | null;
}

async function inspectTypeform(
  frame: Frame,
  src: string,
  iframe: IframeRecord,
  payloads: unknown[],
  page: Page,
): Promise<EmbedInspection> {
  const fetched = await fetchTypeformSchema(page, src);
  const fromPayload = fieldsFromUnknown(payloads);

  const inFrame = await frame.evaluate(() => {
    const next = document.getElementById("__NEXT_DATA__");
    let parsed: unknown = null;
    if (next?.textContent) {
      try {
        parsed = JSON.parse(next.textContent);
      } catch {
        parsed = null;
      }
    }
    const visibleQuestion =
      document.querySelector('[data-qa="block-title"]')?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      null;
    const visibleInputs = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => {
      const html = el as HTMLInputElement;
      return {
        type: html.type || el.tagName.toLowerCase(),
        name: html.name || null,
        placeholder: html.placeholder || null,
        required: html.required,
      };
    });
    const visibleChoices = Array.from(
      document.querySelectorAll('[data-qa="choice"], [role="radio"], [data-qa="choice-option"]'),
    )
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 30);
    const welcomeScreen = Boolean(
      document.querySelector('[data-qa="welcome-screen"], [data-qa="start-button"]') ||
        Array.from(document.querySelectorAll("button, [role='button'], a")).some((el) =>
          /^(start|begin|continue|get started|let's go|let’s go)$/i.test(
            (el.textContent || "").replace(/\s+/g, " ").trim(),
          ),
        ),
    );
    return {
      parsed,
      title: document.title || null,
      visibleQuestion,
      visibleInputs,
      visibleChoices,
      welcomeScreen,
      body: (document.body?.innerText || "").slice(0, 15000),
    };
  });

  const schemaFields = fetched.length
    ? fetched
    : fromPayload.length
      ? fromPayload
      : fieldsFromUnknown([inFrame.parsed]);

  // The welcome screen renders its own heading and button, so anything derived
  // from the visible DOM here would describe the cover, not the questions. The
  // questions are only reachable by clicking Start, which the analyser will not
  // do, so this stays an explicit unknown.
  if (!schemaFields.length && inFrame.welcomeScreen) {
    return {
      form: null,
      limitation:
        "Typeform displayed a welcome screen; its questions sit behind a start button and were not reachable without interacting with the form, and the public Typeform schema could not be fetched",
    };
  }

  const fields = (
    schemaFields.length
      ? schemaFields
      : visibleFields(inFrame.visibleQuestion, inFrame.visibleInputs, inFrame.visibleChoices)
  ).filter((field) => !isJunkField(field));

  if (!fields.length && !inFrame.visibleQuestion && !inFrame.body) {
    return { form: null, limitation: null };
  }

  const heading = inFrame.title || inFrame.visibleQuestion || "Typeform";
  const formKind: FormKind = /application|apply|qualify/i.test(`${heading} ${inFrame.body}`)
    ? "application"
    : fields.length >= 5
      ? "application"
      : "optin";

  return {
    form: toFormRecord({
      kind: formKind,
      src,
      provider: "typeform",
      fields,
      visible: iframe.visible,
      position: iframe.position,
      submitText: "OK / Submit",
      multiStep: true,
      progress: schemaFields.length ? `${schemaFields.length} questions in Typeform schema` : null,
    }),
    limitation: null,
  };
}

async function fetchTypeformSchema(page: Page, src: string): Promise<FormFieldRecord[]> {
  const id = src.match(/\/to\/([^/?#]+)/)?.[1];
  if (!id) return [];
  const urls = [
    `https://form.typeform.com/forms/${id}`,
    `https://api.typeform.com/forms/${id}`,
    `https://form.typeform.com/c/form/${id}`,
  ];
  for (const url of urls) {
    try {
      const response = await page.request.get(url, {
        timeout: 8000,
        headers: { Accept: "application/json" },
      });
      if (!response.ok()) continue;
      const data = await response.json();
      const fields = fieldsFromUnknown([data]);
      if (fields.length) return fields;
    } catch {
      // try the next endpoint
    }
  }
  return [];
}

function isJunkField(field: FormFieldRecord): boolean {
  const blob = `${field.name || ""} ${field.label || ""} ${field.type}`.toLowerCase();
  return /recaptcha|honeypot|csrf|_wpcf7|g-recaptcha/.test(blob) || field.type === "hidden";
}

async function inspectGenericEmbed(
  frame: Frame,
  src: string,
  iframe: IframeRecord,
  provider: string,
): Promise<FormRecord | null> {
  const snapshot = await frame.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label, h1, h2, [data-qa], [class*='question']"))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 2 && t.length < 200)
      .slice(0, 40);
    const inputs = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => {
      const html = el as HTMLInputElement;
      return {
        type: html.type || el.tagName.toLowerCase(),
        name: html.name || null,
        placeholder: html.placeholder || null,
        required: html.required,
        label: html.getAttribute("aria-label"),
      };
    });
    return {
      title: document.title || "",
      body: (document.body?.innerText || "").slice(0, 12000),
      labels,
      inputs,
    };
  });

  const calendar = isCalendarEmbedSrc(src) || /calendly|pick a time|time zone|select a day/i.test(snapshot.body);
  const fields: FormFieldRecord[] = snapshot.inputs
    .filter((input) => !["hidden", "submit", "button"].includes((input.type || "").toLowerCase()))
    .map((input) => fieldFrom({
      label: input.label || input.placeholder || input.name,
      type: input.type,
      required: input.required,
      name: input.name,
    }));

  if (calendar && !fields.length) {
    fields.push({
      name: "calendar",
      id: null,
      label: "Calendar time-slot picker detected",
      type: "calendar",
      placeholder: null,
      required: false,
      autocomplete: null,
      options: [],
      purpose: "other",
      checked: null,
      value_present: false,
      selector: null,
    });
  }

  if (!fields.length && !snapshot.body) return null;

  return toFormRecord({
    kind: calendar ? "booking" : fields.length >= 5 ? "application" : "unknown",
    src,
    provider,
    fields,
    visible: iframe.visible,
    position: iframe.position,
    submitText: calendar ? "Book" : "Submit",
    multiStep: calendar || fields.length > 3,
    progress: null,
  });
}

export function fieldsFromUnknown(nodes: unknown[]): FormFieldRecord[] {
  const found: FormFieldRecord[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    const title = typeof obj.title === "string" ? obj.title : typeof obj.question === "string" ? obj.question : "";
    if (type && TYPEFORM_TYPES.has(type) && type !== "welcome_screen" && type !== "thankyou_screen" && type !== "group") {
      const key = `${type}:${title}`;
      if (title && !seen.has(key)) {
        seen.add(key);
        const validations = (obj.validations || {}) as Record<string, unknown>;
        const properties = (obj.properties || {}) as Record<string, unknown>;
        const choices = Array.isArray(properties.choices)
          ? (properties.choices as Array<Record<string, unknown>>)
              .map((c) => String(c.label || c.ref || ""))
              .filter(Boolean)
          : [];
        found.push(
          fieldFrom({
            label: title,
            type: mapTypeformType(type),
            required: Boolean(validations.required),
            name: typeof obj.ref === "string" ? obj.ref : typeof obj.id === "string" ? obj.id : null,
            options: choices,
          }),
        );
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };

  nodes.forEach(visit);
  return found;
}

function visibleFields(
  question: string | null,
  inputs: Array<{ type: string; name: string | null; placeholder: string | null; required: boolean }>,
  choices: string[],
): FormFieldRecord[] {
  if (question) {
    return [
      fieldFrom({
        label: question,
        type: choices.length ? "radio" : inputs[0]?.type || "text",
        required: Boolean(inputs[0]?.required),
        name: inputs[0]?.name,
        options: choices,
      }),
    ];
  }
  return inputs.map((input) =>
    fieldFrom({
      label: input.placeholder || input.name,
      type: input.type,
      required: input.required,
      name: input.name,
    }),
  );
}

function fieldFrom(input: {
  label?: string | null;
  type?: string | null;
  required?: boolean;
  name?: string | null;
  options?: string[];
}): FormFieldRecord {
  const type = input.type || "text";
  return {
    name: input.name || null,
    id: null,
    label: input.label || null,
    type,
    placeholder: null,
    required: Boolean(input.required),
    autocomplete: null,
    options: input.options || [],
    purpose: inferFieldPurpose({
      name: input.name,
      type,
      label: input.label,
    }),
    checked: null,
    value_present: false,
    selector: null,
  };
}

function mapTypeformType(type: string): string {
  switch (type) {
    case "short_text":
      return "text";
    case "long_text":
      return "textarea";
    case "phone_number":
      return "tel";
    case "multiple_choice":
    case "picture_choice":
      return "radio";
    case "dropdown":
      return "select";
    case "yes_no":
      return "radio";
    case "email":
      return "email";
    case "calendly":
      return "calendar";
    default:
      return type;
  }
}

function toFormRecord(input: {
  kind: FormKind;
  src: string;
  provider: string;
  fields: FormFieldRecord[];
  visible: boolean;
  position: FoldPosition;
  submitText: string;
  multiStep: boolean;
  progress: string | null;
}): FormRecord {
  const raw = {
    selector: `iframe[src*="${input.provider}"]`,
    action: input.src,
    method: "iframe",
    visible: input.visible,
    y: 0,
    fields: input.fields,
    submit_text: input.submitText,
    heading_near: input.provider,
  };
  const friction = measureFriction(raw);
  friction.multi_step = input.multiStep;
  friction.progress_indicator = input.progress;
  return {
    type: input.kind,
    selector: raw.selector,
    action: input.src,
    method: "iframe",
    field_count: input.fields.length,
    fields: input.fields,
    submit_text: input.submitText,
    visible: input.visible,
    position: input.position,
    multi_step: input.multiStep,
    progress_indicator: input.progress,
    estimated_completion_burden: friction.estimated_completion_burden,
    friction,
  };
}
