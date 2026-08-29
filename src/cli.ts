import { randomUUID } from "node:crypto";
import { loadApiConfig } from "./api/config.js";
import { isAllowedUrl, validateTargetUrl } from "./api/url_guard.js";
import { BrowserManager } from "./browser/browser_manager.js";
import { analyzeLandingPage } from "./pipeline/analyze_landing.js";
import { browserConfigFrom } from "./server.js";

/**
 * Local debugging entry point: analyse one URL and print the same JSON the API
 * returns, without starting an HTTP server.
 *
 *   npm run analyze -- https://example.com/offer
 */
async function main(): Promise<number> {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npm run analyze -- <url>");
    return 1;
  }

  const config = loadApiConfig();
  const check = validateTargetUrl(url, { allowPrivateHosts: config.allowPrivateHosts });
  if (!check.ok) {
    console.error(`${check.code}: ${check.message}`);
    return 1;
  }

  const browserConfig = browserConfigFrom(config);
  const browsers = new BrowserManager(browserConfig);
  try {
    const browser = await browsers.get();
    const analysis = await analyzeLandingPage({
      url: check.url.toString(),
      jobId: randomUUID(),
      browser,
      config: browserConfig,
      checkMobileViewport: config.checkMobileViewport,
      linkCheck: {
        enabled: config.checkLinks,
        maxLinks: config.maxLinkChecks,
        timeoutMs: 5000,
        concurrency: 5,
        sameOriginOnly: true,
        isAllowedUrl: (candidate) => isAllowedUrl(candidate, { allowPrivateHosts: config.allowPrivateHosts }),
      },
    });
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await browsers.close();
  }
}

main().then((code) => process.exit(code));
