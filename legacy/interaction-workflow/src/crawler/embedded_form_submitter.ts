import type { Frame, Page } from "playwright";
import type { FormFieldRecord, FormRecord, InteractionResult, TestIdentity, CheckpointHandler } from "../types/index.js";
import { inferFieldPurpose } from "../extraction/field_purpose.js";
import { isSameDocument, waitForPageStable } from "./page_stability.js";
import { logger } from "../logging/logger.js";
import { bookCalendlySlot, isCalendlyStep } from "./calendly_booker.js";
import { dummyNumber, dummyText, pickRandom, usablePhone, valueForIdentity } from "./dummy_answers.js";
import { walkVisibleForm } from "./form_walker.js";

export async function submitEmbeddedForm(
  page: Page,
  form: FormRecord,
  identity: TestIdentity,
  onCheckpoint?: CheckpointHandler,
): Promise<InteractionResult> {
  const before = page.url();
  const provider = providerOf(form);
  const frame = findEmbedFrame(page, form.action);

  if (!frame) {
    return result("submit_form", form.type, before, page.url(), false, "embedded form iframe was not attached");
  }

  try {
    await page.locator(`iframe[src*="${provider}"]`).first().scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => undefined);
    await frame.waitForLoadState("domcontentloaded").catch(() => undefined);

    if (provider === "typeform") {
      await frame
        .locator('[data-qa="start-button"], [data-qa="block-title"], h1, button')
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => undefined);
      return await walkTypeform(page, frame, form, identity, before, onCheckpoint);
    }

    if (provider === "calendly") {
      const booked = await bookCalendlySlot(frame, identity, onCheckpoint);
      const after = page.url();
      return result(
        "submit_form",
        "booking (calendly)",
        before,
        after,
        booked.status === "filled",
        booked.answer || "calendly interaction finished",
      );
    }

    const walked = await walkVisibleForm(frame, identity);
    const after = page.url();
    return result(
      "submit_form",
      `${form.type} (${provider})`,
      before,
      after,
      walked.status === "completed" || walked.answers.length > 0,
      [
        walked.status === "completed" ? "embedded form completed" : "embedded form walked",
        walked.answers.length ? `answers: ${walked.answers.join(" | ")}` : null,
        walked.blocker || null,
      ]
        .filter(Boolean)
        .join(". "),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Embedded form submit failed: ${message}`);
    return result("submit_form", form.type, before, page.url(), false, `submit failed: ${message}`);
  }
}

async function walkTypeform(
  page: Page,
  frame: Frame,
  form: FormRecord,
  identity: TestIdentity,
  before: string,
  onCheckpoint?: CheckpointHandler,
): Promise<InteractionResult> {
  const pagesBefore = new Set(page.context().pages());
  await startTypeform(frame);
  await emitCheckpoint(onCheckpoint, "application_questions", "application", "Application Questions");

  const asked: string[] = [];
  const answers: string[] = [];
  let blocked: string | null = null;
  let lastBlockId: string | null = null;
  let sawThankYou = false;
  let sameBlockTries = 0;

  for (let step = 0; step < 40; step += 1) {
    await frame.locator('[data-qa-focused="true"]').first().waitFor({ timeout: 4000 }).catch(() => undefined);

    if (!isSameDocument(before, page.url())) break;
    if (nonCalendlyPopup(page, pagesBefore)) break;

    const thankYou = await visibleText(frame, /thank you|you'?re all set|submitted|application (received|complete)|we'll be in touch/i);
    if (thankYou) {
      logger.info("Typeform thank-you screen detected");
      sawThankYou = true;
      break;
    }

    const question = await currentQuestion(frame);
    const blockId = await currentBlockId(frame);
    if (blockId && blockId === lastBlockId && step > 0) {
      sameBlockTries += 1;
      logger.info(`Typeform still on the same step (${question || blockId}); retry ${sameBlockTries}`);
      await pressContinue(frame);
      const movedOn = await waitForBlockChange(frame, blockId, 4000);
      if (!movedOn && sameBlockTries >= 5) {
        blocked = `Typeform did not advance past: ${question || "current question"}`;
        break;
      }
      if (movedOn) {
        sameBlockTries = 0;
        lastBlockId = await currentBlockId(frame);
      }
      continue;
    }
    sameBlockTries = 0;
    lastBlockId = blockId;
    if (question) asked.push(question);

    const schema =
      form.fields.find((field) => field.name && field.name === blockId) ||
      matchSchema(question, form.fields);
    const label = question || schema?.label || null;
    let filled: { status: "filled" | "skipped" | "blocked"; answer?: string };
    try {
      filled = await fillCurrentTypeformStep(frame, label, schema, identity, onCheckpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Typeform step failed (${label || "unknown"}): ${message}`);
      filled = { status: "blocked" };
    }
    if (filled.status === "blocked") {
      blocked = `${label || "unlabeled required field"}${filled.answer ? ` (${filled.answer})` : ""}`;
      break;
    }
    if (filled.answer) {
      answers.push(`${label || "step"} → ${filled.answer}`);
      logger.info(`Typeform: ${label || "question"} → ${filled.answer}`);
    }

    const changed = await waitForBlockChange(frame, blockId);
    if (!changed) await pressContinue(frame);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (blocked) break;
    if (await visibleText(frame, /thank you|you'?re all set|submitted|application (received|complete)|we'll be in touch/i)) {
      logger.info("Typeform thank-you screen detected");
      sawThankYou = true;
      break;
    }
    if (!isSameDocument(before, page.url())) break;
    if (nonCalendlyPopup(page, pagesBefore)) break;
    if (await isCalendlyStep(frame, await currentQuestion(frame), "calendar")) break;
    await pressContinue(frame);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (sawThankYou) {
    await emitCheckpoint(onCheckpoint, "form_complete", "thank_you", "Thank-you / confirmation");
  }
  if (!blocked) {
    await waitForPageStable(page).catch(() => []);
    await Promise.race([
      page.waitForURL((url) => !isSameDocument(before, url.toString()), { timeout: 20000 }),
      page.context().waitForEvent("page", { timeout: 20000 }),
    ]).catch(() => undefined);
  }

  const popup = page.context().pages().find((candidate) => !pagesBefore.has(candidate));
  if (popup) await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
  const after = popup ? popup.url() : page.url();
  const iframeAfter = frame.url();
  if (iframeAfter && iframeAfter !== form.action) {
    logger.info(`Typeform iframe navigated to ${iframeAfter}`);
  }

  if (blocked) {
    return result(
      "submit_form",
      `${form.type} (typeform)`,
      before,
      after,
      false,
      `stopped at required field that cannot be filled: ${blocked}. Filled: ${answers.join(" | ") || "none"}`,
    );
  }

  const invalid = await visibleText(frame, /doesn'?t look right|please enter a valid/i);
  const screen = ((await frame.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const moved = !isSameDocument(before, after) || Boolean(popup);
  const submitted = moved || sawThankYou;
  if (!submitted) {
    return result(
      "submit_form",
      `${form.type} (typeform)`,
      before,
      after,
      false,
      `form did not finish after: ${answers.join(" | ") || "no answers"}. screen: ${screen}`,
    );
  }
  return result(
    "submit_form",
    `${form.type} (typeform)`,
    before,
    after,
    submitted && !invalid,
    [
      moved
        ? popup
          ? `opened new tab ${after}`
          : `redirected to ${after}`
        : "typeform thank-you screen after submit",
      answers.length ? `answers: ${answers.join(" | ")}` : null,
      !moved && iframeAfter && iframeAfter !== form.action ? `iframe now ${iframeAfter}` : null,
      invalid ? "validation still visible; form may not have submitted" : null,
      screen ? `screen: ${screen}` : null,
    ]
      .filter(Boolean)
      .join(". "),
  );
}

async function fillCurrentTypeformStep(
  frame: Frame,
  question: string | null,
  schema: FormFieldRecord | null,
  identity: TestIdentity,
  onCheckpoint?: CheckpointHandler,
): Promise<{ status: "filled" | "skipped" | "blocked"; answer?: string }> {
  await tickConsent(frame);

  const purpose = schema?.purpose || inferFieldPurpose({ label: question, type: schema?.type || "text" });
  const identityValue = valueForIdentity(purpose, identity);
  const type = (schema?.type || "").toLowerCase();
  const block = await focusedBlock(frame);

  if (await isCalendlyStep(frame, question, type)) {
    logger.info("Typeform Calendly step detected; picking a time slot");
    return bookCalendlySlot(frame, identity, onCheckpoint);
  }

  const isChoiceQuestion =
    Boolean(schema?.options && schema.options.length > 0) || type === "radio" || type === "select";
  if (isChoiceQuestion) {
    const multi = await isMultiSelect(block);
    const picked = await pickListedChoice(frame, block, schema, !multi);
    if (picked) {
      if (multi) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await pressContinue(frame);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await pressContinue(frame);
      }
      return { status: "filled", answer: picked };
    }
  }

  const choiceButtons = block.locator(
    '[data-qa="choice"]:visible, [role="radio"]:visible, [data-qa="picture-choice"]:visible',
  );
  const choiceCount = await choiceButtons.count();
  if (choiceCount > 0) {
    const index = Math.floor(Math.random() * choiceCount);
    const target = choiceButtons.nth(index);
    const label = ((await target.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    const clicked = await clickChoice(frame, target, index, true);
    if (!clicked) return { status: "blocked" };
    if (await isMultiSelect(block)) await pressContinue(frame);
    return { status: "filled", answer: label || `choice ${index + 1}` };
  }
  if (isChoiceQuestion) {
    return { status: "blocked", answer: "no clickable choice was available" };
  }

  const inputs = block.locator(
    'input:visible:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea:visible',
  );
  const inputCount = await inputs.count();
  if (inputCount === 0) {
    if (type === "contact_info" || type === "statement" || /we need the correct contact/i.test(question || "")) {
      await pressContinue(frame);
      return { status: "skipped", answer: "(statement / continue)" };
    }
    return { status: "skipped" };
  }

  const filled: string[] = [];
  for (let i = 0; i < inputCount; i += 1) {
    const input = inputs.nth(i);
    const meta = {
      type: (await input.getAttribute("type")) || "",
      name: (await input.getAttribute("name")) || "",
      placeholder: (await input.getAttribute("placeholder")) || "",
      autocomplete: (await input.getAttribute("autocomplete")) || "",
      aria: (await input.getAttribute("aria-label")) || "",
      inputMode: (await input.getAttribute("inputmode")) || "",
    };
    if (/recaptcha|honeypot|g-recaptcha/i.test(`${meta.name} ${meta.aria} ${meta.placeholder}`)) continue;

    const fieldPurpose =
      inputCount === 1 && purpose !== "other"
        ? purpose
        : inferFieldPurpose({
            label: `${question || ""} ${meta.aria} ${meta.placeholder}`,
            type: meta.type,
            name: meta.name,
            placeholder: meta.placeholder,
            autocomplete: meta.autocomplete,
          });
    let typed =
      valueForIdentity(fieldPurpose, identity) ||
      (inputCount === 1 ? identityValue : null) ||
      dummyText(`${question || ""} ${meta.aria} ${meta.placeholder}`, schema?.type || meta.type);
    if (fieldPurpose === "phone" || meta.type === "tel" || meta.inputMode === "tel") {
      typed = usablePhone(typed || identity.phone);
    }
    if (meta.type === "number" || meta.inputMode === "numeric" || meta.inputMode === "decimal" || schema?.type === "number") {
      typed = dummyNumber(`${question || ""} ${meta.aria}`);
    }
    if (!typed) return { status: "blocked" };

    await input.click({ timeout: 3000, force: true }).catch(() => undefined);
    await input.fill("", { timeout: 2000 }).catch(() => undefined);
    await input.fill(typed, { timeout: 3000 });
    filled.push(typed);
  }

  if (!filled.length) return { status: "skipped" };
  await pressContinue(frame);
  if (await visibleText(frame, /doesn'?t look right|invalid (phone|email|number)|please enter a valid/i)) {
    const phoneInput = block.locator('input[type="tel"], input[inputmode="tel"], input[inputmode="numeric"]').first();
    if (await phoneInput.count()) {
      const fallback = "2024567890";
      await phoneInput.fill(fallback, { timeout: 3000 }).catch(() => undefined);
      filled.push(`phone-retry ${fallback}`);
      await pressContinue(frame);
    }
  }
  return { status: "filled", answer: filled.join(", ") };
}

async function focusedBlock(frame: Frame) {
  const focused = frame.locator('[data-qa-focused="true"]').first();
  if (await focused.count()) return focused;
  return frame.locator("body");
}

async function startTypeform(frame: Frame): Promise<void> {
  const start = frame.locator('[data-qa="start-button"]').first();
  if (await start.isVisible().catch(() => false)) {
    await start.click({ timeout: 4000, force: true }).catch(() => undefined);
  } else {
    await clickNamed(frame, /^(start|begin|continue)$/i);
  }
  await frame.locator('[data-qa-focused="true"], [data-qa="choice"], [data-qa="block-title"]').first().waitFor({ timeout: 8000 }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 600));
}

async function clickChoice(
  frame: Frame,
  choice: ReturnType<Frame["locator"]>,
  index: number,
  confirmAdvance: boolean,
): Promise<boolean> {
  await choice.scrollIntoViewIfNeeded().catch(() => undefined);
  const before = await currentBlockId(frame);
  const clicked = await choice.click({ timeout: 2500, force: true }).then(() => true).catch(() => false);
  if (!clicked) {
    await choice.press("Enter").catch(() => undefined);
    await choice.press(index < 9 ? String(index + 1) : "1").catch(() => undefined);
  }
  if (!confirmAdvance) return true;
  if (await waitForBlockChange(frame, before, 2500)) return true;
  await choice.press("Enter").catch(() => undefined);
  return waitForBlockChange(frame, before, 2000);
}

async function tickConsent(frame: Frame): Promise<void> {
  const boxes = frame.locator(
    '[data-qa="legal-checkbox"]:visible, input[type="checkbox"]:visible, [role="checkbox"]:visible',
  );
  const count = await boxes.count();
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    const checked = await box.isChecked().catch(() => false);
    if (!checked) await box.click({ timeout: 2000 }).catch(() => undefined);
  }
}

async function isMultiSelect(block: ReturnType<Frame["locator"]>): Promise<boolean> {
  const text = ((await block.innerText().catch(() => "")) || "").toLowerCase();
  return /as many as you like|select all that apply|choose all that apply/.test(text);
}

async function pickListedChoice(
  frame: Frame,
  block: ReturnType<Frame["locator"]>,
  schema: FormFieldRecord | null,
  confirmAdvance: boolean,
): Promise<string | null> {
  const radios = block.locator('[data-qa="choice"]:visible, [role="radio"]:visible, [data-qa="picture-choice"]:visible');
  const frameRadios = frame.locator(
    '[data-qa-focused="true"] [data-qa="choice"]:visible, [data-qa-focused="true"] [role="radio"]:visible, [data-qa-focused="true"] [data-qa="picture-choice"]:visible',
  );
  const live: string[] = [];
  const count = await radios.count();
  for (let i = 0; i < count; i += 1) {
    const label = ((await radios.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    const disabled = (await radios.nth(i).getAttribute("aria-disabled").catch(() => null)) === "true";
    if (label && !disabled && (await radios.nth(i).isEnabled().catch(() => true))) live.push(label);
  }
  const schemaOptions = (schema?.options || []).filter((option) => option && !/^other$/i.test(option));
  const usableLive = live.filter((label) => !/^other$/i.test(label));
  const pool = usableLive.length ? usableLive : schemaOptions;
  if (!pool.length) return null;
  const option = pickRandom(pool);
  const snippet = option.slice(0, 22);
  const scoped = radios.filter({ hasText: snippet }).first();
  const global = frameRadios.filter({ hasText: snippet }).first();
  const target = (await scoped.count()) ? scoped : global;
  const fallback = block.getByText(snippet, { exact: false }).first();
  const clickable = (await target.count()) ? target : fallback;
  if (await clickable.count()) {
    const index = Math.max(0, pool.indexOf(option));
    if (await clickChoice(frame, clickable, index, confirmAdvance)) return option;
    await clickable.click({ force: true, timeout: 2500 }).catch(() => undefined);
    return option;
  }
  return null;
}

function matchSchema(question: string | null, fields: FormFieldRecord[]): FormFieldRecord | null {
  if (!question) return null;
  const q = question.toLowerCase();
  return (
    fields.find((field) => {
      const label = (field.label || "").toLowerCase();
      if (!label) return false;
      return q.includes(label.slice(0, 24)) || label.includes(q.slice(0, 24));
    }) || null
  );
}

async function currentBlockId(frame: Frame): Promise<string | null> {
  const loc = frame.locator('[data-qa-focused="true"]').first();
  if (!(await loc.count())) return null;
  return (await loc.getAttribute("data-qa-blockref")) || (await loc.getAttribute("id"));
}

async function currentQuestion(frame: Frame): Promise<string | null> {
  const block = frame.locator('[data-qa-focused="true"]').first();
  const locators = [
    block.locator('[id$="-title"]').first(),
    block.locator('[data-qa="block-title"]').first(),
    block.locator("h1").first(),
    frame.locator('[data-qa="block-title"]').first(),
    frame.locator("h1").first(),
  ];
  for (const loc of locators) {
    const text = (await loc.textContent({ timeout: 500 }).catch(() => null))?.replace(/\s+/g, " ").trim();
    if (text) return text.replace(/^\d+\s*→\s*/, "").trim();
  }
  return null;
}

async function pressContinue(frame: Frame): Promise<void> {
  const focused = frame.locator('[data-qa-focused="true"]').first();
  const ok = focused
    .locator('[data-qa="ok-button-visible"], [data-qa="ok-button"], [data-qa="submit-button"], button')
    .filter({ hasText: /^(ok|continue|next|submit)$/i })
    .first();
  if (await ok.isVisible().catch(() => false)) {
    await ok.click({ timeout: 3000, force: true }).catch(() => undefined);
    return;
  }
  const globalOk = frame.locator('[data-qa="ok-button-visible"], [data-qa="ok-button"], [data-qa="submit-button"]').first();
  if ((await globalOk.count()) && (await globalOk.isVisible().catch(() => false))) {
    await globalOk.click({ timeout: 3000, force: true }).catch(() => undefined);
    return;
  }
  const submit = frame.getByRole("button", { name: /^(ok|continue|next|submit|done)$/i }).first();
  if ((await submit.count()) && (await submit.isVisible().catch(() => false))) {
    await submit.click({ timeout: 3000, force: true }).catch(() => undefined);
    return;
  }
  if (await clickNamed(frame, /^(ok|continue|next|submit|done)$/i)) return;
  await frame.page().keyboard.press("Enter").catch(() => undefined);
}

async function clickNamed(frame: Frame, name: RegExp): Promise<boolean> {
  const button = frame.getByRole("button", { name }).first();
  if ((await button.count()) && (await button.isVisible().catch(() => false))) {
    await button.click({ timeout: 3000, force: true }).catch(() => undefined);
    return true;
  }
  return false;
}

async function visibleText(frame: Frame, pattern: RegExp): Promise<boolean> {
  const body = await frame.locator("body").innerText().catch(() => "");
  return pattern.test(body);
}

async function waitForBlockChange(frame: Frame, previousId: string | null, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await currentBlockId(frame);
    if (next && previousId && next !== previousId) return true;
    if (!previousId && next) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function findEmbedFrame(page: Page, action: string | null): Frame | null {
  const frames = page.frames();
  if (action) {
    const exact = frames.find((frame) => frame.url() === action);
    if (exact) return exact;
    try {
      const path = new URL(action, page.url()).pathname;
      const byPath = frames.find((frame) => frame.url().includes(path));
      if (byPath) return byPath;
    } catch {
      // ignore invalid action URLs
    }
  }
  return (
    frames.find((frame) => /typeform\.com/i.test(frame.url())) ||
    frames.find((frame) => /calendly\.com|cal\.com/i.test(frame.url())) ||
    frames.find((frame) => /leadconnectorhq|msgsndr|gohighlevel|form-builder/i.test(frame.url())) ||
    frames.find((frame) => /jotform\.com|tally\.so|fillout\.com|paperform\.co|forms\.gle/i.test(frame.url())) ||
    null
  );
}

function providerOf(form: FormRecord): string {
  const blob = `${form.action || ""} ${form.selector || ""}`.toLowerCase();
  if (blob.includes("typeform")) return "typeform";
  if (blob.includes("calendly")) return "calendly";
  if (/leadconnector|msgsndr|gohighlevel/.test(blob)) return "gohighlevel";
  return "iframe";
}

function result(
  action: string,
  element: string,
  before: string,
  after: string,
  success: boolean,
  message: string,
): InteractionResult {
  return {
    action,
    element,
    success,
    before_url: before,
    after_url: after,
    result: message,
    timestamp: new Date().toISOString(),
  };
}

function nonCalendlyPopup(page: Page, pagesBefore: Set<Page>): boolean {
  return page
    .context()
    .pages()
    .some((candidate) => !pagesBefore.has(candidate) && !/calendly/i.test(candidate.url()));
}

const emittedKinds = new WeakMap<CheckpointHandler, Set<string>>();

async function emitCheckpoint(
  onCheckpoint: CheckpointHandler | undefined,
  kind: Parameters<CheckpointHandler>[0]["kind"],
  pageType: Parameters<CheckpointHandler>[0]["pageType"],
  label: string,
  details?: string,
): Promise<void> {
  if (!onCheckpoint) return;
  const seen = emittedKinds.get(onCheckpoint) || new Set<string>();
  if (seen.has(kind)) return;
  seen.add(kind);
  emittedKinds.set(onCheckpoint, seen);
  await onCheckpoint({ kind, pageType, label, details });
}
