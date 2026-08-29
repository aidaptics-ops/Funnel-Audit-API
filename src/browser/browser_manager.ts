import { chromium, type Browser } from "playwright";
import type { BrowserConfig } from "../types/index.js";
import { logger } from "../logging/logger.js";

/**
 * Container-safe Chromium flags. The sandbox is disabled because Render (and
 * most container runtimes) do not grant the namespaces Chromium needs for it.
 */
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-gpu",
];

/**
 * Owns a single long-lived browser process. Each analysis gets its own context,
 * not its own browser, so requests stay isolated without paying launch cost.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly config: BrowserConfig) {}

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const channel = this.config.browser_channel?.trim();
    const options = { headless: this.config.headless, args: LAUNCH_ARGS };

    if (channel) {
      try {
        logger.info(`Launching Chromium channel "${channel}" (headless=${this.config.headless})`);
        this.browser = await chromium.launch({ ...options, channel });
        return this.browser;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Channel "${channel}" unavailable (${message}); using bundled Chromium.`);
      }
    }

    logger.info(`Launching bundled Chromium (headless=${this.config.headless})`);
    this.browser = await chromium.launch(options);
    return this.browser;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }

  get connected(): boolean {
    return Boolean(this.browser?.isConnected());
  }
}
