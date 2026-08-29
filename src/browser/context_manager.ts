import type { Browser, BrowserContext } from "playwright";
import type { BrowserConfig, DeviceProfileName } from "../types/index.js";
import { getDeviceProfile } from "../config/profiles.js";

export interface ContextOptions {
  device?: DeviceProfileName;
}

/**
 * One isolated context per analysis: no shared cookies, storage or cache
 * between requests. The caller always closes it.
 */
export async function createContext(
  browser: Browser,
  config: BrowserConfig,
  options?: ContextOptions,
): Promise<BrowserContext> {
  const profile = getDeviceProfile(options?.device || config.device);

  const context = await browser.newContext({
    viewport: profile.viewport,
    userAgent: profile.userAgent,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    locale: "en-US",
    timezoneId: "America/New_York",
    javaScriptEnabled: true,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  context.setDefaultTimeout(config.timeout_ms);
  context.setDefaultNavigationTimeout(config.navigation_timeout_ms);

  // esbuild/tsx name helper: some evaluated snippets are transpiled before they
  // reach the page, and reference this shim.
  await context.addInitScript(`
    globalThis.__name = globalThis.__name || function (target) { return target; };
  `);

  return context;
}
