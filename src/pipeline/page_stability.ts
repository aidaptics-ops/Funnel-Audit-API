import type { Locator, Page } from "playwright";
import { logger } from "../logging/logger.js";

const NETWORK_IDLE_MS = 8000;
const MUTATION_QUIET_MS = 450;
const MUTATION_MAX_MS = 5000;

export async function waitForPageStable(page: Page, timeoutMs = 30000): Promise<string[]> {
  const events: string[] = [];

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    events.push("domcontentloaded");
  } catch {
    events.push("domcontentloaded_timeout");
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS });
    events.push("networkidle");
  } catch {
    events.push("networkidle_timeout");
  }

  try {
    await page.evaluate(
      `globalThis.__name = globalThis.__name || function (target) { return target; };`,
    );
    await page.evaluate(
      async ({ quiet, max }: { quiet: number; max: number }) => {
        await new Promise<void>((resolve) => {
          let settled: ReturnType<typeof setTimeout> | undefined;
          const done = () => {
            observer.disconnect();
            resolve();
          };
          const observer = new MutationObserver(() => {
            if (settled) clearTimeout(settled);
            settled = setTimeout(done, quiet);
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          settled = setTimeout(done, quiet);
          setTimeout(done, max);
        });
      },
      { quiet: MUTATION_QUIET_MS, max: MUTATION_MAX_MS },
    );
    events.push("dom_quiet");
  } catch {
    events.push("dom_quiet_failed");
  }

  return events;
}


/**
 * Cookie/consent containers only. Every selector here has to be paired with the
 * wording check below: patterns like [class*="cmp" i] also match unrelated
 * component classes (AEM's "cmp-*"), so the class name alone proves nothing.
 */
const CONSENT_CONTAINER_SELECTOR = [
  "#onetrust-banner-sdk",
  '[id*="onetrust" i]',
  '[id*="cookiebot" i]',
  "#cookiescript_injected",
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[aria-label*="cookie" i]',
  '[class*="osano" i]',
  '[class*="cmp" i]',
  ".cc-window",
  '[role="dialog"]',
].join(", ");

const CONSENT_WORDING = /cookie|consent|gdpr|ccpa|personal data|tracking technolog/i;
const ACCEPT_LABEL =
  /^(accept|accept all|accept all cookies|accept cookies|accept & close|allow|allow all|allow all cookies|allow cookies|agree|i agree|i accept|ok|okay|got it|understood)$/i;

/** CMPs (OneTrust, Cookiebot, Osano) inject after load, so give them a moment. */
const CONSENT_WAIT_MS = 1500;
const CONSENT_POLL_MS = 250;
/** Guards against a page-wide wrapper whose class happens to contain "consent". */
const CONSENT_TEXT_MAX = 4000;
const MAX_CANDIDATES = 12;
const MAX_CONTROLS = 25;

interface ControlMeta {
  label: string;
  tag: string;
  type: string;
  href: string;
  inForm: boolean;
}

/**
 * Dismisses a cookie/consent banner and nothing else. The analyser must never
 * submit a form or trigger a CTA on a prospect's page, so the accept control is
 * only ever looked for inside a container that is provably a consent notice,
 * and at most one control is clicked per call.
 */
export async function dismissObstructions(page: Page): Promise<string[]> {
  const container = await findConsentContainer(page);
  if (!container) return [];

  const controls = await container
    .locator('button, [role="button"], input[type="button"], a')
    .filter({ visible: true })
    .all()
    .catch(() => []);

  const urlBefore = page.url();

  for (const control of controls.slice(0, MAX_CONTROLS)) {
    const meta = await readControlMeta(control);
    // "Got it!" and "Accept." are the same control as "Got it" / "Accept".
    if (!meta || !ACCEPT_LABEL.test(meta.label.replace(/[!.]+$/, ""))) continue;
    // A control that lives in a form, declares itself a submit, or is a real
    // link would post data or navigate: never worth a cleaner screenshot.
    if (meta.inForm || meta.type === "submit" || navigatesAway(meta)) continue;

    const clicked = await control
      .click({ timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) return [];

    const dismissed = [`consent_banner_accepted:${meta.label}`];
    const urlAfter = page.url();
    if (!isSameDocument(urlBefore, urlAfter)) {
      dismissed.push(`consent_click_navigated:${urlBefore} -> ${urlAfter}`);
    }
    // At most one control per call: a second click would land on an unknown
    // document if the first one navigated.
    return dismissed;
  }

  return [];
}

async function findConsentContainer(page: Page) {
  const deadline = Date.now() + CONSENT_WAIT_MS;
  for (;;) {
    const candidates = await page
      .locator(CONSENT_CONTAINER_SELECTOR)
      .filter({ visible: true })
      .all()
      .catch(() => []);

    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      const info = await candidate
        .evaluate(
          (el) => ({
            tag: el.tagName.toLowerCase(),
            text: ((el as HTMLElement).innerText || el.textContent || "").slice(0, 8000),
          }),
          undefined,
          { timeout: 1000 },
        )
        .catch(() => null);
      if (!info) continue;
      if (info.tag === "html" || info.tag === "body") continue;
      if (info.text.length > CONSENT_TEXT_MAX) continue;
      if (!CONSENT_WORDING.test(info.text)) continue;
      return candidate;
    }

    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(CONSENT_POLL_MS).catch(() => undefined);
  }
}

async function readControlMeta(control: Locator): Promise<ControlMeta | null> {
  return control
    .evaluate(
      (el) => {
        const label =
          (el as HTMLElement).innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          "";
        return {
          label: label.replace(/\s+/g, " ").trim(),
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") || "").toLowerCase(),
          href: el.getAttribute("href") || "",
          inForm: Boolean(el.closest("form")),
        };
      },
      undefined,
      { timeout: 1000 },
    )
    .catch(() => null);
}

function navigatesAway(meta: ControlMeta): boolean {
  if (meta.tag !== "a") return false;
  const href = meta.href.trim();
  return href !== "" && href !== "#" && !/^javascript:/i.test(href);
}

export function detectBlocker(title: string, text: string): string | null {
  const blob = `${title}\n${text}`.toLowerCase();
  if (/just a moment|attention required|checking your browser|verify you are human|cf-challenge/.test(blob)) {
    return "anti-bot challenge page detected";
  }
  if (/access denied|403 forbidden|request blocked/.test(blob)) {
    return "access denied page detected";
  }
  return null;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname !== "/") {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Origin + path + query, ignoring hash fragments. */
export function documentUrl(url: string): string {
  return normalizeUrl(url);
}

export function isHashOnlyChange(before: string, after: string): boolean {
  return Boolean(before && after && before !== after && documentUrl(before) === documentUrl(after));
}

export function isSameDocument(before: string, after: string): boolean {
  return documentUrl(before) === documentUrl(after);
}

export function isBrowserErrorUrl(url: string): boolean {
  return /^(chrome-error:|chrome:\/\/|edge-error:|about:neterror|about:blank)/i.test(url);
}

export { logger };
