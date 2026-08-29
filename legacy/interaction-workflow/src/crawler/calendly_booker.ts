import type { Frame, Locator } from "playwright";
import type { CheckpointHandler, TestIdentity } from "../types/index.js";
import { logger } from "../logging/logger.js";
import { pickRandom } from "./dummy_answers.js";
import { preferredCalendlyChoice } from "./calendly_choices.js";
import { walkVisibleForm } from "./form_walker.js";
import {
  dummyPhonesForCountry,
  resolvePhoneCountry,
  valuesToType,
  type DummyPhone,
  type PhoneCountryHints,
} from "./phone_for_country.js";

const rejectedCalendlyPhones = new Set<string>();

export async function isCalendlyStep(frame: Frame, question: string | null, type: string): Promise<boolean> {
  if (type === "calendar" || type === "calendly") return true;
  if (/book a|strategy session|calendly|pick a time|select a (day|date)/i.test(question || "")) {
    return true;
  }
  return Boolean(findCalendlyFrame(frame));
}

export async function bookCalendlySlot(
  host: Frame,
  identity: TestIdentity,
  onCheckpoint?: CheckpointHandler,
): Promise<{ status: "filled" | "blocked"; answer?: string }> {
  try {
    return await bookCalendlySlotInner(host, identity, onCheckpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Calendly booking failed: ${message}`);
    return { status: "blocked", answer: message };
  }
}

async function bookCalendlySlotInner(
  host: Frame,
  identity: TestIdentity,
  onCheckpoint?: CheckpointHandler,
): Promise<{ status: "filled" | "blocked"; answer?: string }> {
  const startUrl = host.page().url();
  await host
    .page()
    .locator('iframe[src*="typeform"], iframe[src*="calendly"]')
    .first()
    .scrollIntoViewIfNeeded({ timeout: 4000 })
    .catch(() => undefined);
  await host
    .getByText(/time zone|select a (day|date)|august|september|october|available/i)
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  await waitForCalendlyFrame(host);

  const frames = calendarFrames(host);
  logger.info(`Calendly candidate frames: ${frames.map((frame) => frame.url() || "blank").join(" | ") || "host only"}`);
  await waitForCalendarGrid(frames[0] || host);
  await notifyCheckpoint(onCheckpoint, {
    kind: "calendar",
    pageType: "calendar",
    label: "Calendly",
  });

  const picked: string[] = [];
  let active = frames[0] || host;
  let pickedDay = false;
  let pickedTime = false;
  let clickedNext = false;
  let filledQuestions = false;
  let scheduled = false;

  for (let step = 0; step < 24; step += 1) {
    const liveFrames = uniqueFrames([active, ...calendarFrames(host), host]);
    for (const frame of liveFrames) {
      await dismissCalendlyNoise(frame);
      if (host.page().url() !== startUrl) {
        logger.info(`Calendly booking redirected to ${host.page().url()}`);
        return { status: "filled", answer: picked.join(" → ") || "slot booked" };
      }
      if (await confirmationVisible(frame)) {
        logger.info("Calendly confirmation detected");
        await notifyCheckpoint(onCheckpoint, {
          kind: "booking_confirmation",
          pageType: "confirmation",
          label: "Booking Confirmation",
          details: picked.join(" → "),
        });
        return { status: "filled", answer: picked.join(" → ") || "slot booked" };
      }
      if (scheduled) {
        await sleep(1000);
        break;
      }

      if (clickedNext && !filledQuestions) {
        await waitForInviteeForm(frame);
        const extra = await fillCalendlyInviteeForm(frame, identity);
        if (extra.length) {
          picked.push(...extra);
          logger.info(`Calendly questions: ${extra.join(" | ")}`);
        }
        filledQuestions = true;
        active = frame;
        await sleep(400);
        break;
      }

      if (clickedNext && filledQuestions && !scheduled) {
        const booked = await trySchedule(frame, identity);
        if (booked) {
          scheduled = true;
          picked.push(booked);
          active = frame;
          logger.info("Calendly Schedule Event clicked");
          await sleep(5000);
          if (await hasInviteeValidation(frame)) {
            logger.warn("Calendly validation still visible; filling again");
            await rememberRejectedCalendlyPhone(frame);
            scheduled = false;
            const retry = await fillCalendlyInviteeForm(frame, identity);
            if (retry.length) picked.push(...retry);
            await trySchedule(frame, identity);
            scheduled = true;
            await sleep(4000);
          }
          break;
        }
      }

      if (pickedTime && !clickedNext) {
        const next = await waitForNextButton(frame, 4500);
        if (next) {
          await next.click({ force: true, timeout: 3000 }).catch(() => undefined);
          clickedNext = true;
          picked.push("next");
          active = frame;
          logger.info("Calendly Next after time");
          await sleep(1200);
          await notifyCheckpoint(onCheckpoint, {
            kind: "calendar_questions",
            pageType: "booking",
            label: "Calendly Questions",
            details: picked.filter((item) => item !== "next").join(" → "),
          });
          break;
        }
      }

      if (!pickedTime) {
        const time = await pickRandomTime(frame);
        if (time) {
          picked.push(time);
          pickedTime = true;
          active = frame;
          logger.info(`Calendly time ${time}`);
          await sleep(900);
          break;
        }

        if (!pickedDay) {
          const day = await pickRandomDay(frame);
          if (day) {
            picked.push(day);
            pickedDay = true;
            active = frame;
            logger.info(`Calendly day ${day}`);
            await frame
              .getByRole("button", { name: /^\d{1,2}:\d{2}\s*(am|pm)$/i })
              .first()
              .waitFor({ state: "visible", timeout: 8000 })
              .catch(() => undefined);
            await sleep(400);
            break;
          }
          if (await goNextMonth(frame)) {
            active = frame;
            await sleep(600);
            break;
          }
        }
      }
      await sleep(400);
    }
    await sleep(300);
  }

  if (await confirmationVisible(active)) {
    await notifyCheckpoint(onCheckpoint, {
      kind: "booking_confirmation",
      pageType: "confirmation",
      label: "Booking Confirmation",
      details: picked.join(" → "),
    });
    return { status: "filled", answer: picked.join(" → ") || "slot booked" };
  }
  const screen = ((await active.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (screen) logger.warn(`Calendly end state: ${screen}`);
  return {
    status: "blocked",
    answer: picked.length
      ? `stopped after ${picked.join(" → ")}${screen ? `. screen: ${screen}` : ""}`
      : "no available Calendly slot could be selected",
  };
}
function calendarFrames(host: Frame): Frame[] {
  const pageFrames = host.page().frames();
  const calendly = pageFrames.filter((frame) => /^https:\/\/(?:www\.)?calendly\.com\//i.test(frame.url()));
  if (calendly.length) return uniqueFrames(calendly);
  const wrapped = pageFrames.filter((frame) => /typeform\.com\/applications\/calendly/i.test(frame.url()));
  if (wrapped.length) return uniqueFrames(wrapped);
  return uniqueFrames([host]);
}

function uniqueFrames(frames: Frame[]): Frame[] {
  return [...new Set(frames)];
}

async function waitForCalendarGrid(cal: Frame): Promise<void> {
  const locators = [
    cal.locator('button[aria-label*="Times available"], button[aria-label*="times available"]'),
    cal.getByRole("button", { name: /times available/i }),
    cal.locator('[role="gridcell"] button:not([disabled])'),
    cal.getByText(/select a (day|date)|time zone/i),
  ];
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const loc of locators) {
      if (await loc.first().isVisible().catch(() => false)) return;
    }
    await sleep(250);
  }
  logger.warn("Calendly calendar grid did not become visible in time");
}

async function waitForCalendlyFrame(host: Frame): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (host.page().frames().some((frame) => /^https:\/\/(?:www\.)?calendly\.com\//i.test(frame.url()))) {
      return;
    }
    await sleep(250);
  }
}

function findCalendlyFrame(root: Frame): Frame | null {
  const matches: Frame[] = [];
  const walk = (frame: Frame) => {
    if (/calendly/i.test(frame.url())) matches.push(frame);
    for (const child of frame.childFrames()) walk(child);
  };
  walk(root);
  for (const frame of root.page().frames()) {
    if (/calendly/i.test(frame.url()) && !matches.includes(frame)) matches.push(frame);
  }
  return matches.find((frame) => /calendly\.com/i.test(frame.url())) || matches[matches.length - 1] || null;
}

async function dismissCalendlyNoise(cal: Frame): Promise<void> {
  const accept = cal
    .locator("#onetrust-accept-btn-handler, button:has-text('Accept all'), button:has-text('Accept')")
    .first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click({ force: true, timeout: 2000 }).catch(() => undefined);
  }
}

async function pickRandomDay(cal: Frame): Promise<string | null> {
  const locators = [
    cal.locator('button[aria-label*="Times available"], button[aria-label*="times available"]'),
    cal.getByRole("button", { name: /times available/i }),
    cal.locator('[role="gridcell"] button:not([disabled]):not([aria-disabled="true"])'),
  ];
  const available: Array<{ label: string; index: number; group: (typeof locators)[0] }> = [];
  for (const group of locators) {
    const count = await group.count();
    for (let i = 0; i < Math.min(count, 40); i += 1) {
      const button = group.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      if ((await button.getAttribute("aria-disabled").catch(() => null)) === "true") continue;
      if (!(await button.isEnabled().catch(() => false))) continue;
      const label = (
        (await button.getAttribute("aria-label").catch(() => null)) ||
        (await button.innerText().catch(() => "")) ||
        "day"
      )
        .replace(/\s+/g, " ")
        .trim();
      if (/previous|next|month|time zone/i.test(label)) continue;
      available.push({ label, index: i, group });
    }
    if (available.length) break;
  }
  if (!available.length) return null;
  const chosen = pickRandom(available);
  await chosen.group.nth(chosen.index).click({ force: true, timeout: 4000 }).catch(() => undefined);
  return chosen.label;
}

async function pickRandomTime(cal: Frame): Promise<string | null> {
  const named = cal.getByRole("button", { name: /^\d{1,2}:\d{2}\s*(am|pm)$/i });
  const slots: Array<{ text: string; index: number }> = [];
  const count = await named.count();
  for (let i = 0; i < count; i += 1) {
    const button = named.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    if ((await button.getAttribute("aria-disabled").catch(() => null)) === "true") continue;
    if (!(await button.isEnabled().catch(() => false))) continue;
    const text = ((await button.innerText().catch(() => "")) || "time").replace(/\s+/g, " ").trim();
    if (!isTimeSlotLabel(text)) continue;
    slots.push({ text, index: i });
  }
  if (!slots.length) return null;
  const chosen = pickRandom(slots);
  await named.nth(chosen.index).click({ force: true, timeout: 4000 }).catch(() => undefined);
  return chosen.text;
}

function isTimeSlotLabel(text: string): boolean {
  return /^\d{1,2}:\d{2}\s*(am|pm)$/i.test(text.trim());
}

async function waitForNextButton(cal: Frame, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const candidates = [
    cal.getByRole("button", { name: /^next$/i }).first(),
    cal.locator("button").filter({ hasText: /^next$/i }).first(),
    cal.locator('[data-container="selected-spot"] button, [data-container="time-slot"] button').filter({ hasText: /next/i }).first(),
  ];
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await sleep(200);
  }
  return null;
}

async function waitForInviteeForm(cal: Frame): Promise<void> {
  await cal
    .getByLabel(/first name/i)
    .or(cal.locator('input[name="first_name"], input[autocomplete="given-name"]'))
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => undefined);
}

async function fillCalendlyInviteeForm(cal: Frame, identity: TestIdentity): Promise<string[]> {
  const answers: string[] = [];
  const first = identity.first_name || "Alex";
  const last = identity.last_name || "Taylor";
  const email = identity.email || "";

  if (await fillLabeledInput(cal, /first name/i, 'input[name="first_name"], input[autocomplete="given-name"]', first)) {
    answers.push(`First name → ${first}`);
  }
  if (await fillLabeledInput(cal, /last name/i, 'input[name="last_name"], input[autocomplete="family-name"]', last)) {
    answers.push(`Last name → ${last}`);
  }
  if (email && (await fillLabeledInput(cal, /^email/i, 'input[type="email"], input[name="email"]', email, { onlyIfEmpty: true }))) {
    answers.push(`Email → ${email}`);
  }

  const radios = await pickCalendlyRadios(cal);
  answers.push(...radios);

  const leftover = await walkVisibleForm(cal, identity, { maxSteps: 3, skipSchedulingChrome: true });
  answers.push(...leftover.answers);

  const radiosAgain = await pickCalendlyRadios(cal);
  answers.push(...radiosAgain);

  const phone = await fillCalendlyPhone(cal);
  if (phone) answers.push(phone);
  return answers;
}

async function fillLabeledInput(
  cal: Frame,
  label: RegExp,
  fallback: string,
  value: string,
  opts?: { onlyIfEmpty?: boolean },
): Promise<boolean> {
  const byLabel = cal.getByLabel(label).first();
  const bySelector = cal.locator(fallback).first();
  const input = (await byLabel.isVisible().catch(() => false)) ? byLabel : bySelector;
  if (!(await input.isVisible().catch(() => false))) return false;
  const current = await input.inputValue().catch(() => "");
  if (opts?.onlyIfEmpty && current.trim()) return false;
  await input.click({ force: true, timeout: 2000 }).catch(() => undefined);
  await input.fill("", { timeout: 2000 }).catch(() => undefined);
  await input.fill(value, { timeout: 3000 }).catch(async () => {
    await input.pressSequentially(value, { delay: 20 }).catch(() => undefined);
  });
  return true;
}

function phoneLocator(cal: Frame): Locator {
  return cal
    .getByLabel(/phone/i)
    .or(
      cal.locator(
        'input[type="tel"], input[name="phone"], input[name="phone_number"], input[autocomplete="tel"], .PhoneInputInput',
      ),
    )
    .first();
}

async function fillCalendlyPhone(cal: Frame): Promise<string | null> {
  const phone = phoneLocator(cal);
  if (!(await phone.isVisible().catch(() => false))) return null;

  const country = resolvePhoneCountry(await readPhoneCountryHints(cal, phone));
  if (!country) {
    logger.warn("Calendly phone: could not detect the selected country in the phone widget");
    return null;
  }

  const candidates = dummyPhonesForCountry(country, 8);
  if (!candidates.length) {
    logger.warn(`Calendly phone: no valid-format test numbers for ${country}`);
    return null;
  }

  logger.info(`Calendly phone: selected country ${country} (+${candidates[0]?.callingCode})`);
  const errorAlreadyShowing = await calendlyPhoneRejected(cal);
  let last: DummyPhone | null = null;
  for (const candidate of candidates) {
    last = candidate;
    for (const value of valuesToType(candidate)) {
      const key = phoneAttemptKey(country, value);
      if (rejectedCalendlyPhones.has(key)) continue;
      await typeIntoPhone(phone, value);
      if (errorAlreadyShowing) {
        logger.info(`Calendly phone: retrying +${candidate.callingCode} ${candidate.national}`);
        return `Phone → +${candidate.callingCode} ${candidate.national} (${country})`;
      }
      await phone.blur().catch(async () => {
        await phone.press("Tab").catch(() => undefined);
      });
      await sleep(450);
      if (!(await calendlyPhoneRejected(cal))) {
        logger.info(`Calendly phone: accepted +${candidate.callingCode} ${candidate.national}`);
        return `Phone → +${candidate.callingCode} ${candidate.national} (${country})`;
      }
      rejectedCalendlyPhones.add(key);
      logger.warn(`Calendly phone: rejected ${value} for ${country}; trying another valid-format number`);
    }
  }

  if (last) {
    await typeIntoPhone(phone, last.national);
    return `Phone → +${last.callingCode} ${last.national} (${country})`;
  }
  return null;
}

async function typeIntoPhone(phone: Locator, value: string): Promise<void> {
  await phone.click({ force: true, timeout: 2000 }).catch(() => undefined);
  await phone.fill("", { timeout: 2000 }).catch(() => undefined);
  await phone.fill(value, { timeout: 3000 }).catch(async () => {
    await phone.pressSequentially(value, { delay: 20 }).catch(() => undefined);
  });
}

async function calendlyPhoneRejected(cal: Frame): Promise<boolean> {
  const error = cal
    .getByText(/phone number format is not recognized|check the country and number|enter a valid phone|invalid phone/i)
    .first();
  return error.isVisible().catch(() => false);
}

function phoneAttemptKey(country: string, value: string): string {
  return `${country}:${value.replace(/\D/g, "")}`;
}

async function rememberRejectedCalendlyPhone(cal: Frame): Promise<void> {
  if (!(await calendlyPhoneRejected(cal))) return;
  const phone = phoneLocator(cal);
  const value = (await phone.inputValue().catch(() => "")) || "";
  const country = resolvePhoneCountry(await readPhoneCountryHints(cal, phone));
  if (!country || !value.replace(/\D/g, "")) return;
  rejectedCalendlyPhones.add(phoneAttemptKey(country, value));
}

async function readPhoneCountryHints(cal: Frame, phone: Locator): Promise<PhoneCountryHints> {
  const select = cal
    .locator("select.PhoneInputCountrySelect, select[aria-label*='country' i], select[name*='country' i]")
    .first();
  const isoFromSelect = (await select.inputValue().catch(() => "")) || "";
  const optionLabel = (await select.locator("option:checked").innerText().catch(() => "")) || "";

  const widget = await phone
    .evaluate((el) => {
      const root =
        (el.closest(".PhoneInput, .iti, [class*='PhoneInput']") as HTMLElement | null) ||
        el.parentElement?.parentElement ||
        el.parentElement;
      const native = root?.querySelector("select") as HTMLSelectElement | null;
      const flag = root?.querySelector(
        "[data-country-code], [data-country], .iti__selected-flag, .PhoneInputCountry",
      ) as HTMLElement | null;
      const img = root?.querySelector("img");
      const combo = root?.querySelector('[role="combobox"], button');
      const nearby = (root?.innerText || "").replace(/\s+/g, " ").slice(0, 400);
      const calling = nearby.match(/\+(\d{1,4})/);
      return {
        iso:
          native?.value ||
          flag?.getAttribute("data-country-code") ||
          flag?.getAttribute("data-country") ||
          "",
        optionLabel: native?.selectedOptions?.[0]?.textContent || "",
        imgAlt: img?.getAttribute("alt") || "",
        title: flag?.getAttribute("title") || combo?.getAttribute("title") || "",
        aria:
          combo?.getAttribute("aria-label") ||
          flag?.getAttribute("aria-label") ||
          el.getAttribute("aria-label") ||
          "",
        nearby,
        inputValue: (el as HTMLInputElement).value || "",
        callingCode: calling?.[1] || "",
      };
    })
    .catch(() => null);

  return {
    iso: isoFromSelect || widget?.iso,
    callingCode: widget?.callingCode,
    countryName: optionLabel || widget?.optionLabel || widget?.imgAlt || widget?.title || widget?.aria,
    inputValue: widget?.inputValue,
    extraText: [widget?.title, widget?.aria, widget?.nearby].filter(Boolean).join(" | "),
  };
}

async function pickCalendlyRadios(cal: Frame): Promise<string[]> {
  const answers: string[] = [];
  const grouped = new Map<string, number[]>();
  const radios = cal.locator('input[type="radio"]');
  const count = await radios.count();
  for (let i = 0; i < count; i += 1) {
    const name = (await radios.nth(i).getAttribute("name").catch(() => null)) || `anon-${i}`;
    const list = grouped.get(name) || [];
    list.push(i);
    grouped.set(name, list);
  }
  for (const [, indexes] of grouped) {
    const labels: Array<{ index: number; text: string }> = [];
    for (const index of indexes) {
      const radio = radios.nth(index);
      const id = await radio.getAttribute("id").catch(() => null);
      const viaFor = id ? ((await cal.locator(`label[for="${id}"]`).innerText().catch(() => "")) || "") : "";
      const viaParent = ((await radio.locator("xpath=ancestor::label[1]").innerText().catch(() => "")) || "").trim();
      const text = (viaFor || viaParent).replace(/\s+/g, " ").trim();
      if (text) labels.push({ index, text });
    }
    if (!labels.length) continue;
    const chosen = preferredCalendlyChoice(labels.map((item) => item.text));
    const picked = labels.find((item) => item.text === chosen) || labels[0];
    if (!picked) continue;
    const radio = radios.nth(picked.index);
    const already = await radio.isChecked().catch(() => false);
    if (!already) {
      await radio.check({ force: true }).catch(async () => {
        await cal.getByText(picked.text.slice(0, 40), { exact: false }).first().click({ force: true }).catch(() => undefined);
      });
    }
    answers.push(`choice → ${picked.text}`);
  }

  if (!answers.length) {
    const understand = cal.getByText(/i understand/i).first();
    if (await understand.isVisible().catch(() => false)) {
      await understand.click({ force: true, timeout: 3000 }).catch(() => undefined);
      answers.push("choice → I understand");
    }
  }
  return answers;
}

async function hasInviteeValidation(cal: Frame): Promise<boolean> {
  const body = ((await cal.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  return /not recognized|must be selected|one answer|can't be blank|required|doesn't look right/.test(body);
}

async function trySchedule(cal: Frame, identity: TestIdentity): Promise<string | null> {
  const schedule = cal.getByRole("button", { name: /schedule( event)?/i }).first();
  const confirm = cal.getByRole("button", { name: /confirm/i }).first();
  const target = (await schedule.isVisible().catch(() => false))
    ? schedule
    : (await confirm.isVisible().catch(() => false))
      ? confirm
      : null;
  if (!target) return null;

  await fillCalendlyInviteeForm(cal, identity);
  await target.click({ force: true, timeout: 4000 }).catch(() => undefined);
  return "scheduled";
}

async function goNextMonth(cal: Frame): Promise<boolean> {
  const next = cal.locator('button[aria-label*="next month"], button[aria-label*="Next month"]').first();
  if (await next.isVisible().catch(() => false)) {
    await next.click({ force: true, timeout: 2000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function confirmationVisible(cal: Frame): Promise<boolean> {
  const body = ((await cal.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  return /appointment is scheduled|you('re| are) scheduled|confirmed|booking confirmed|event scheduled/.test(
    body,
  );
}

async function notifyCheckpoint(
  onCheckpoint: CheckpointHandler | undefined,
  checkpoint: Parameters<CheckpointHandler>[0],
): Promise<void> {
  if (!onCheckpoint) return;
  try {
    await onCheckpoint(checkpoint);
  } catch (error) {
    logger.warn(`Calendly checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
