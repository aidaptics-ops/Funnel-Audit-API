import type {
  ApplicationFriction,
  DomSnapshot,
  FormKind,
  FormRecord,
  RawFormSnapshot,
} from "../types/index.js";

export function extractForms(snapshot: DomSnapshot): FormRecord[] {
  return snapshot.forms.map((raw) => {
    const type = classifyForm(raw, snapshot);
    const friction = type === "application" ? measureFriction(raw) : measureFriction(raw);
    return {
      type,
      selector: raw.selector,
      action: raw.action,
      method: raw.method,
      field_count: raw.fields.length,
      fields: raw.fields,
      submit_text: raw.submit_text,
      visible: raw.visible,
      position: raw.y < snapshot.viewport.height ? "above_fold" : "below_fold",
      multi_step: detectMultiStep(snapshot, raw),
      progress_indicator: detectProgress(snapshot),
      estimated_completion_burden: estimateBurden(raw),
      friction,
    };
  });
}

export function classifyForm(raw: RawFormSnapshot, snapshot: DomSnapshot): FormKind {
  const blob = [
    raw.heading_near,
    raw.submit_text,
    ...raw.fields.map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`),
    snapshot.title,
  ]
    .join(" ")
    .toLowerCase();

  const purposes = raw.fields.map((f) => f.purpose);
  const hasPassword = purposes.includes("password");
  const hasPayment = purposes.includes("payment");
  const fieldCount = raw.fields.length;
  const selectCount = raw.fields.filter((f) => f.type === "select" || f.options.length > 0).length;
  const textAreaCount = raw.fields.filter((f) => f.type === "textarea").length;

  if (hasPassword || /\b(log\s*in|sign\s*in|password)\b/.test(blob)) return "login";
  if (hasPayment || /\b(checkout|credit card|payment|billing)\b/.test(blob)) return "checkout";
  if (/\b(search)\b/.test(blob) && fieldCount <= 2 && purposes.includes("search")) return "search";
  if (/\b(book|schedule|calendly|appointment|pick a time)\b/.test(blob)) return "booking";
  if (
    fieldCount >= 5 ||
    selectCount >= 2 ||
    /\b(apply|application|qualify|questionnaire)\b/.test(blob)
  ) {
    return "application";
  }
  if (/\b(webinar|workshop|masterclass|register|save (my )?spot|join us)\b/.test(blob)) {
    return "webinar_registration";
  }
  if (
    purposes.includes("email") &&
    fieldCount <= 4 &&
    /\b(subscribe|download|free|opt[ -]?in|get access|join)\b/.test(blob)
  ) {
    return "optin";
  }
  if (purposes.includes("email") && fieldCount <= 3) return "optin";
  if (textAreaCount >= 1 && fieldCount <= 6) return "contact";
  return "unknown";
}

export function measureFriction(raw: RawFormSnapshot): ApplicationFriction {
  const questionTypes = Array.from(new Set(raw.fields.map((f) => f.type)));
  const freeResponse = raw.fields.filter(
    (f) => f.type === "textarea" || (f.type === "text" && f.purpose === "other"),
  ).length;
  const multipleChoice = raw.fields.filter(
    (f) => f.type === "select" || f.type === "radio" || f.type === "checkbox",
  ).length;
  const required = raw.fields.filter((f) => f.required).length;

  const contactIndex = raw.fields.findIndex((f) =>
    ["email", "phone", "first_name", "last_name", "full_name"].includes(f.purpose),
  );

  return {
    question_count: raw.fields.length,
    question_types: questionTypes,
    free_response_count: freeResponse,
    multiple_choice_count: multipleChoice,
    required_count: required,
    contact_fields_position:
      contactIndex === -1
        ? "not_detected"
        : contactIndex <= 1
          ? "beginning"
          : contactIndex >= raw.fields.length - 2
            ? "end"
            : "middle",
    multi_step: false,
    progress_indicator: null,
    estimated_completion_burden: estimateBurden(raw),
  };
}

function detectMultiStep(snapshot: DomSnapshot, raw: RawFormSnapshot): boolean {
  const text = snapshot.visible_text.toLowerCase();
  return (
    /step\s*[1-9]\s*(of|\/)\s*[1-9]/.test(text) ||
    /next\s*(question|step)/i.test(raw.submit_text || "") ||
    Boolean(raw.heading_near && /step\s+\d/i.test(raw.heading_near))
  );
}

function detectProgress(snapshot: DomSnapshot): string | null {
  const match = snapshot.visible_text.match(/step\s*[1-9]\s*(of|\/)\s*[1-9]/i);
  return match ? match[0] : null;
}

function estimateBurden(raw: RawFormSnapshot): string {
  const n = raw.fields.length;
  const required = raw.fields.filter((f) => f.required).length;
  const long = raw.fields.filter((f) => f.type === "textarea").length;
  if (n >= 10 || long >= 3) return `high (${n} fields, ${required} required)`;
  if (n >= 5) return `medium (${n} fields, ${required} required)`;
  return `low (${n} fields, ${required} required)`;
}
