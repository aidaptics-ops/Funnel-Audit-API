import type { Frame, Locator } from "playwright";
import type { TestIdentity } from "../types/index.js";
import { inferFieldPurpose } from "../extraction/field_purpose.js";
import { isCalendlyDeclineChoice, preferredCalendlyChoice } from "./calendly_choices.js";
import { dummyNumber, dummyText, pickRandom, usablePhone, valueForIdentity } from "./dummy_answers.js";
import { logger } from "../logging/logger.js";

export interface WalkOutcome {
  status: "completed" | "blocked" | "in_progress";
  answers: string[];
  blocker?: string;
}

export async function walkVisibleForm(
  frame: Frame,
  identity: TestIdentity,
  opts?: { maxSteps?: number; skipSchedulingChrome?: boolean },
): Promise<WalkOutcome> {
  const answers: string[] = [];
  let lastSignature = "";
  let stuck = 0;

  for (let step = 0; step < (opts?.maxSteps ?? 30); step += 1) {
    if (await looksComplete(frame)) {
      return { status: "completed", answers };
    }

    await tickConsent(frame);
    const signature = await stepSignature(frame);
    const filled = await fillVisibleStep(frame, identity, opts?.skipSchedulingChrome);
    if (filled.answers.length) {
      answers.push(...filled.answers);
      for (const line of filled.answers) logger.info(`Form: ${line}`);
    }

    await continueStep(frame, opts?.skipSchedulingChrome);
    await sleep(400);

    const next = await stepSignature(frame);
    if (next === lastSignature && next === signature) {
      stuck += 1;
      if (stuck >= 4) {
        return {
          status: filled.blocked ? "blocked" : answers.length ? "in_progress" : "blocked",
          answers,
          blocker: filled.blocked || "form did not advance after filling the visible step",
        };
      }
    } else {
      stuck = 0;
    }
    lastSignature = next;
  }

  return {
    status: (await looksComplete(frame)) ? "completed" : "in_progress",
    answers,
  };
}

async function fillVisibleStep(
  frame: Frame,
  identity: TestIdentity,
  skipSchedulingChrome = false,
): Promise<{ answers: string[]; blocked?: string }> {
  const answers: string[] = [];
  const question = await visibleQuestion(frame);

  const selects = frame.locator("select:visible");
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i += 1) {
    const select = selects.nth(i);
    if (skipSchedulingChrome && (await isPhoneCountrySelect(select))) continue;
    const picked = await pickSelectOption(select);
    if (picked) answers.push(`${question || "dropdown"} → ${picked}`);
  }

  const choices = frame.locator(
    '[data-qa="choice"]:visible, [role="radio"]:visible, [role="option"]:visible, input[type="radio"], [role="radiogroup"] label:visible, fieldset label:visible',
  );
  const choiceCount = await choices.count();
  if (choiceCount > 0 && !skipSchedulingChrome) {
    const labels: string[] = [];
    for (let i = 0; i < choiceCount; i += 1) {
      const label = ((await choices.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const disabled = (await choices.nth(i).getAttribute("aria-disabled").catch(() => null)) === "true";
      const enabled = await choices.nth(i).isEnabled().catch(() => true);
      if (label && !disabled && enabled && !isSchedulingChrome(label) && !isCalendlyDeclineChoice(label)) {
        labels.push(label);
      }
    }
    if (labels.length) {
      const picked = preferredCalendlyChoice(labels) || pickRandom(labels);
      const target = choices.filter({ hasText: picked.slice(0, 24) }).first();
      await target.click({ force: true, timeout: 4000 }).catch(() => undefined);
      answers.push(`${question || "choice"} → ${picked}`);
    }
  }

  const inputs = frame.locator(
    'input:visible:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea:visible',
  );
  const inputCount = await inputs.count();
  for (let i = 0; i < inputCount; i += 1) {
    const input = inputs.nth(i);
    const meta = {
      type: (await input.getAttribute("type")) || "",
      name: (await input.getAttribute("name")) || "",
      placeholder: (await input.getAttribute("placeholder")) || "",
      autocomplete: (await input.getAttribute("autocomplete")) || "",
      aria: (await input.getAttribute("aria-label")) || "",
      id: (await input.getAttribute("id")) || "",
      inputMode: (await input.getAttribute("inputmode")) || "",
    };
    if (/recaptcha|honeypot|g-recaptcha|timezone/i.test(`${meta.name} ${meta.aria} ${meta.placeholder}`)) continue;
    const existing = await input.inputValue().catch(() => "");
    if (existing.trim() && meta.type !== "tel" && meta.inputMode !== "tel") continue;

    let ownLabel = meta.aria;
    if (meta.id) {
      ownLabel =
        ((await frame.locator(`label[for="${meta.id}"]`).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim() ||
        ownLabel;
    }
    const purpose = inferFieldPurpose({
      label: ownLabel || question,
      type: meta.type,
      name: meta.name,
      placeholder: meta.placeholder,
      autocomplete: meta.autocomplete,
    });
    if (skipSchedulingChrome && (purpose === "phone" || meta.type === "tel" || meta.inputMode === "tel")) continue;
    let typed = valueForIdentity(purpose, identity) || dummyText(`${question || ""} ${meta.aria}`, meta.type);
    if (purpose === "phone" || meta.type === "tel" || meta.inputMode === "tel") typed = usablePhone(typed || identity.phone);
    if (meta.type === "number" || meta.inputMode === "numeric" || meta.inputMode === "decimal") {
      const min = Number(await input.getAttribute("min"));
      const max = Number(await input.getAttribute("max"));
      typed = dummyNumber(question, Number.isFinite(min) ? min : 20, Number.isFinite(max) ? max : 55);
    }
    if (meta.type === "date") typed = dummyText(question, "date");
    if (!typed) return { answers, blocked: question || meta.aria || "required field" };

    await input.click({ timeout: 2000, force: true }).catch(() => undefined);
    await input.fill(typed, { timeout: 3000 }).catch(() => undefined);
    answers.push(`${ownLabel || question || meta.aria || meta.placeholder || meta.type} → ${typed}`);
  }

  return { answers };
}

async function isPhoneCountrySelect(select: Locator): Promise<boolean> {
  const hint = [
    await select.getAttribute("aria-label").catch(() => ""),
    await select.getAttribute("name").catch(() => ""),
    await select.getAttribute("class").catch(() => ""),
    await select.getAttribute("id").catch(() => ""),
  ].join(" ");
  return /country|PhoneInputCountry/i.test(hint);
}

async function pickSelectOption(select: Locator): Promise<string | null> {
  const options = select.locator("option:not([disabled])");
  const count = await options.count();
  const values: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = ((await options.nth(i).innerText().catch(() => "")) || "").trim();
    const raw = (await options.nth(i).getAttribute("value").catch(() => "")) || "";
    if (!value || /select|choose/i.test(value) || raw === "") continue;
    values.push(value);
  }
  if (!values.length) return null;
  const picked = pickRandom(values);
  await select.selectOption({ label: picked }).catch(() => undefined);
  return picked;
}

async function continueStep(frame: Frame, skipSchedulingChrome = false): Promise<void> {
  const pattern = skipSchedulingChrome
    ? /^(ok|continue|done|send)$/i
    : /^(ok|continue|next|submit|done|send|schedule( event)?)$/i;
  const named = frame.getByRole("button", { name: pattern }).first();
  if (await named.isVisible().catch(() => false)) {
    await named.click({ force: true, timeout: 3000 }).catch(() => undefined);
    return;
  }
  if (skipSchedulingChrome) return;
  const qa = frame.locator('[data-qa="ok-button-visible"], [data-qa="submit-button"]').first();
  if (await qa.isVisible().catch(() => false)) {
    await qa.click({ force: true, timeout: 3000 }).catch(() => undefined);
    return;
  }
  await frame.page().keyboard.press("Enter").catch(() => undefined);
}

async function tickConsent(frame: Frame): Promise<void> {
  const boxes = frame.locator('input[type="checkbox"]:visible, [role="checkbox"]:visible, [data-qa="legal-checkbox"]');
  const count = await boxes.count();
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    if (!(await box.isChecked().catch(() => false))) await box.click({ force: true, timeout: 2000 }).catch(() => undefined);
  }
}

async function visibleQuestion(frame: Frame): Promise<string | null> {
  const locators = [
    frame.locator('[data-qa-focused="true"] [id$="-title"]').first(),
    frame.locator('[data-qa="block-title"]').first(),
    frame.locator("h1, h2, legend, label").first(),
  ];
  for (const loc of locators) {
    const text = (await loc.textContent({ timeout: 400 }).catch(() => null))?.replace(/\s+/g, " ").trim();
    if (text) return text.replace(/^\d+\s*→\s*/, "").trim();
  }
  return null;
}

async function looksComplete(frame: Frame): Promise<boolean> {
  const body = ((await frame.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  return /thank you|appointment is scheduled|you('re| are) (all set|scheduled|confirmed)|booking confirmed|application (received|complete)|we'll be in touch/.test(
    body,
  );
}

async function stepSignature(frame: Frame): Promise<string> {
  const question = (await visibleQuestion(frame)) || "";
  const body = ((await frame.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 180);
  return `${question}|${body}`;
}

function isSchedulingChrome(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  return (
    /^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(text) ||
    /time zone|times available|previous|next month|eastern time|pacific time|central time|mountain time/i.test(
      text,
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
