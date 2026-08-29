import type { Locator, Page } from "playwright";
import type {
  CheckpointHandler,
  CrawlConfig,
  FormFieldRecord,
  FormRecord,
  InteractionResult,
  PageRecord,
  TestIdentity,
} from "../types/index.js";
import { identityIsUsable } from "../config/load_config.js";
import { logger } from "../logging/logger.js";
import type { ScreenshotManager } from "../screenshots/screenshot_manager.js";
import { waitForPageStable, isHashOnlyChange, isSameDocument } from "./page_stability.js";
import { dummyText, pickRandom, usablePhone, valueForIdentity } from "./dummy_answers.js";
import { submitEmbeddedForm } from "./embedded_form_submitter.js";

const FUNNEL_HOSTS = [
  "calendly.com",
  "cal.com",
  "tidycal.com",
  "acuityscheduling.com",
  "kajabi.com",
  "clickfunnels.com",
  "kartra.com",
  "thrivecart.com",
  "samcart.com",
  "stripe.com",
  "checkout.com",
  "hubspot.com",
  "typeform.com",
  "convertkit.com",
  "kit.com",
  "activehosted.com",
  "kartra.com",
  "gohighlevel.com",
  "leadpages.co",
  "webinarjam.com",
  "stealthseminar.com",
  "demio.com",
  "zoom.us",
];

export class InteractionEngine {
  constructor(
    private readonly config: CrawlConfig,
    private readonly screenshots: ScreenshotManager,
  ) {}

  canSubmitForms(): boolean {
    return this.config.submit_forms && identityIsUsable(this.config.test_identity);
  }

  pickForm(pageRecord: PageRecord): FormRecord | null {
    const visible = pageRecord.forms.filter((f) => f.visible && f.type !== "search");
    const ranked = [...visible].sort((a, b) => rankForm(a, pageRecord) - rankForm(b, pageRecord));
    const best = ranked[0];
    if (!best) return null;
    if (best.type === "checkout" && !this.config.submit_checkout) return null;
    if (best.type === "login") return null;
    if (rankForm(best, pageRecord) >= 50) return null;
    return best;
  }

  async submitForm(
    page: Page,
    form: FormRecord,
    pageRecord: PageRecord,
    step: number,
    onCheckpoint?: CheckpointHandler,
  ): Promise<InteractionResult> {
    const identity = this.config.test_identity;
    const before = page.url();
    const now = new Date().toISOString();

    if (!this.canSubmitForms() || !identity) {
      return {
        action: "submit_form",
        element: form.type,
        success: false,
        before_url: before,
        after_url: before,
        result: "form not submitted because no test email/phone was supplied",
        timestamp: now,
      };
    }

    if (form.method === "iframe") {
      await this.screenshots.capture(page, {
        step,
        pageType: pageRecord.page_type,
        kind: "before_submit",
        fullPage: false,
      });
      const embedded = await submitEmbeddedForm(page, form, identity, onCheckpoint);
      await this.screenshots.capture(page, {
        step,
        pageType: pageRecord.page_type,
        kind: "after_submit",
        fullPage: false,
      });
      return embedded;
    }

    const unfilledRequired = form.fields.filter(
      (field) => field.required && !canFill(field, identity) && field.purpose !== "consent",
    );
    if (unfilledRequired.length) {
      return {
        action: "submit_form",
        element: form.type,
        success: false,
        before_url: before,
        after_url: before,
        result: `required field(s) could not be filled without inventing data: ${unfilledRequired
          .map((f) => f.label || f.name || f.type)
          .join(", ")}`,
        timestamp: now,
      };
    }

    await this.screenshots.capture(page, {
      step,
      pageType: pageRecord.page_type,
      kind: "before_submit",
      fullPage: false,
    });

    try {
      for (const field of form.fields) {
        await this.fillField(page, field, identity);
      }

      const submitted = await this.clickSubmit(page, form);
      if (!submitted) {
        return {
          action: "submit_form",
          element: form.type,
          success: false,
          before_url: before,
          after_url: page.url(),
          result: "submit control was not found or was not clickable",
          timestamp: new Date().toISOString(),
        };
      }

      const after = await waitForOutcome(page, before);
      return {
        action: "submit_form",
        element: `${form.type}${form.submit_text ? ` (${form.submit_text})` : ""}`,
        success: true,
        before_url: before,
        after_url: after,
        result:
          after !== before
            ? `redirected to ${after}`
            : "submit clicked; URL did not change (page may have updated in place)",
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Form submit failed: ${message}`);
      return {
        action: "submit_form",
        element: form.type,
        success: false,
        before_url: before,
        after_url: page.url(),
        result: `submit failed: ${message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  pickCta(
    pageRecord: PageRecord,
    visited: Set<string>,
    options?: { clicked?: Set<string>; skipApply?: boolean },
  ): { text: string; href: string | null; selectorHint?: string } | null {
    const startHost = safeHost(this.config.start_url);
    const submitLabels = new Set(
      pageRecord.forms
        .map((form) => (form.submit_text || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const clicked = options?.clicked;
    const skipApply = Boolean(options?.skipApply);
    const candidates = pageRecord.ctas.filter((cta) => {
      if (!cta.visible) return false;
      if (!cta.text || cta.text.length > 80) return false;
      if (submitLabels.has(cta.text.trim().toLowerCase())) return false;
      if (clicked?.has(cta.text.trim().toLowerCase())) return false;
      if (skipApply && /\bapply\b/i.test(cta.text)) return false;
      if (cta.href && visited.has(normalizeHref(cta.href))) return false;
      if (cta.href && !isAllowedHref(cta.href, startHost)) return false;
      return looksFunnelCta(cta.text);
    });
    return candidates[0]
      ? { text: candidates[0].text, href: candidates[0].href }
      : null;
  }

  async clickCta(
    page: Page,
    cta: { text: string; href: string | null },
    pageRecord: PageRecord,
    step: number,
  ): Promise<{ result: InteractionResult; page: Page }> {
    const before = page.url();
    await this.screenshots.capture(page, {
      step,
      pageType: pageRecord.page_type,
      kind: "before_cta",
      fullPage: false,
    });

    try {
      const context = page.context();
      const pagesBefore = new Set(context.pages());
      const locator = page.getByRole("link", { name: cta.text, exact: false }).first();
      const button = page.getByRole("button", { name: cta.text, exact: false }).first();
      const target = (await locator.count()) > 0 ? locator : button;

      if ((await target.count()) === 0) {
        if (cta.href) {
          await page.goto(cta.href, { waitUntil: "domcontentloaded" });
        } else {
          return {
            page,
            result: failure("click_cta", cta.text, before, page.url(), "CTA element was not found"),
          };
        }
      } else {
        await target.click({ timeout: 5000 });
      }

      await waitForPageStable(page).catch(() => []);
      await page.locator('iframe[src*="typeform"], iframe[src*="calendly"]').first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      const popup = context.pages().find((candidate) => !pagesBefore.has(candidate)) || null;
      let active = page;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
        active = popup;
      }
      const after = await waitForOutcome(active, before);
      const hashOnly = isHashOnlyChange(before, after);
      const sameDocument = isSameDocument(before, after);
      let resultText: string;
      if (popup) resultText = `opened new tab ${after}`;
      else if (!sameDocument) resultText = `navigated to ${after}`;
      else if (hashOnly) {
        const hash = (() => {
          try {
            return new URL(after).hash || "#";
          } catch {
            return "#";
          }
        })();
        resultText = `in-page reveal (hash changed to ${hash}); not a new page`;
      } else {
        resultText = "in-page reveal; URL did not change (modal, scroll, or embed)";
      }
      return {
        page: active,
        result: {
          action: "click_cta",
          element: cta.text,
          success: true,
          before_url: before,
          after_url: after,
          result: resultText,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        page,
        result: failure("click_cta", cta.text, before, page.url(), `click failed: ${message}`),
      };
    }
  }

  private async fillField(page: Page, field: FormFieldRecord, identity: TestIdentity): Promise<void> {
    const value = valueFor(field, identity);
    const locator = locatorFor(page, field);
    if (!locator) return;

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return;

    if (field.purpose === "consent" && (field.type === "checkbox" || field.type === "radio")) {
      const checked = await locator.isChecked().catch(() => false);
      if (!checked) await locator.check({ force: true }).catch(() => undefined);
      return;
    }

    if (value == null && field.type !== "radio" && field.type !== "select" && field.type !== "checkbox") return;

    if (field.type === "select") {
      const options = (field.options || []).filter((option) => option && !/^select|choose/i.test(option));
      const chosen = options.length ? pickRandom(options) : value;
      if (chosen) {
        await locator.selectOption({ label: chosen }).catch(async () => {
          await locator.selectOption({ index: 1 }).catch(() => undefined);
        });
      }
      return;
    }

    if (field.type === "radio") {
      const options = (field.options || []).filter((option) => option && !/^select|choose/i.test(option));
      if (options.length) {
        const chosen = pickRandom(options);
        const labeled = page.getByLabel(chosen, { exact: false }).first();
        if (await labeled.count()) {
          await labeled.click({ force: true }).catch(() => undefined);
          return;
        }
      }
      const group = field.name
        ? page.locator(`input[type="radio"][name="${cssEscape(field.name)}"]`)
        : page.locator('input[type="radio"]:visible');
      const count = await group.count();
      if (count > 0) {
        await group.nth(Math.floor(Math.random() * count)).check({ force: true }).catch(() => undefined);
      }
      return;
    }

    if (field.type === "checkbox" && field.purpose !== "consent") {
      if (Math.random() < 0.5) {
        const checked = await locator.isChecked().catch(() => false);
        if (!checked) await locator.check({ force: true }).catch(() => undefined);
      }
      return;
    }

    if (value == null) return;

    await locator.fill(value, { timeout: 3000 }).catch(async () => {
      await locator.click({ force: true }).catch(() => undefined);
      await page.keyboard.type(value, { delay: 20 }).catch(() => undefined);
    });
  }

  private async clickSubmit(page: Page, form: FormRecord): Promise<boolean> {
    if (form.submit_text) {
      const named = page.getByRole("button", { name: form.submit_text, exact: false }).first();
      if (await named.count()) {
        await named.click({ timeout: 5000 });
        return true;
      }
    }
    if (form.selector) {
      const scoped = page.locator(form.selector).locator("button[type='submit'], input[type='submit'], button:not([type])").first();
      if (await scoped.count()) {
        await scoped.click({ timeout: 5000 });
        return true;
      }
    }
    const generic = page.locator("form button[type='submit'], form input[type='submit']").first();
    if (await generic.count()) {
      await generic.click({ timeout: 5000 });
      return true;
    }
    return false;
  }
}

function canFill(field: FormFieldRecord, identity: TestIdentity): boolean {
  return field.purpose !== "payment" && field.purpose !== "password";
}

function valueFor(field: FormFieldRecord, identity: TestIdentity): string | null {
  if (field.purpose === "consent") return null;
  if (field.purpose === "payment" || field.purpose === "password") return null;
  return (
    valueForIdentity(field.purpose, identity) ||
    (field.type === "tel" ? usablePhone(identity.phone) : null) ||
    dummyText(field.label, field.type)
  );
}

function locatorFor(page: Page, field: FormFieldRecord): Locator | null {
  if (field.selector) return page.locator(field.selector).first();
  if (field.id) return page.locator(`#${cssEscape(field.id)}`).first();
  if (field.name) return page.locator(`[name="${cssEscape(field.name)}"]`).first();
  if (field.label) return page.getByLabel(field.label, { exact: false }).first();
  return null;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function rankForm(form: FormRecord, page: PageRecord): number {
  if (form.type === "search") return 99;
  if (form.type === "login") return 90;
  if (form.type === page.page_type) return 0;
  if (page.page_type === "webinar_registration" && form.type === "optin") return 1;
  if (form.type === "application") return form.method === "iframe" ? 1 : 2;
  if (form.type === "optin" || form.type === "webinar_registration") return 3;
  if (form.type === "contact") return 8;
  if (form.type === "unknown") return 10;
  return 20;
}

function looksFunnelCta(text: string): boolean {
  return /\b(apply|book|schedule|register|get access|watch|join|buy|start|get started|save (my )?spot|reserve|claim|enroll|continue|yes|submit|download|unlock)\b/i.test(
    text,
  );
}

function isAllowedHref(href: string, startHost: string | null): boolean {
  try {
    const url = new URL(href);
    if (["mailto:", "tel:", "javascript:"].includes(url.protocol)) return false;
    if (startHost && url.hostname.replace(/^www\./, "") === startHost) return true;
    return FUNNEL_HOSTS.some((host) => url.hostname.endsWith(host));
  } catch {
    return false;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeHref(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    return u.toString();
  } catch {
    return href;
  }
}

async function waitForOutcome(page: Page, before: string): Promise<string> {
  if (!isSameDocument(before, page.url())) return page.url();
  try {
    await page.waitForURL((url) => !isSameDocument(before, url.toString()), { timeout: 4000 });
  } catch {
    await waitForPageStable(page).catch(() => []);
  }
  return page.url();
}

function failure(
  action: string,
  element: string,
  before: string,
  after: string,
  result: string,
): InteractionResult {
  return {
    action,
    element,
    success: false,
    before_url: before,
    after_url: after,
    result,
    timestamp: new Date().toISOString(),
  };
}
