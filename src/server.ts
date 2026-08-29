import { loadApiConfig, type ApiConfig } from "./api/config.js";
import { isAllowedUrl } from "./api/url_guard.js";
import { startServer, type AnalysisBudget } from "./api/server.js";
import { BrowserManager } from "./browser/browser_manager.js";
import { analyzeLandingPage, type AnalyzeLandingOptions } from "./pipeline/analyze_landing.js";
import { logger } from "./logging/logger.js";
import type { BrowserConfig } from "./types/index.js";

export function browserConfigFrom(config: ApiConfig): BrowserConfig {
  return {
    headless: config.headless,
    device: "desktop",
    timeout_ms: config.browserTimeoutMs,
    navigation_timeout_ms: config.navigationTimeoutMs,
    browser_channel: config.browserChannel,
  };
}

export async function main(): Promise<void> {
  const config = loadApiConfig();
  const browserConfig = browserConfigFrom(config);
  const browsers = new BrowserManager(browserConfig);
  await startServer(
    config,
    {
      analyze: async (url, jobId, budget) => {
        // An instance without a browser is unhealthy, not a bad request; the
        // tag is what turns this into a 503 the platform can act on.
        const browser = await browsers.get().catch((error: unknown) => {
          throw browserUnavailable(error);
        });

        // Typed as an intersection so the capture pipeline receives the HTTP
        // layer's remaining budget and can cancel itself instead of running on
        // after the client has already been answered.
        const request: AnalyzeLandingOptions & Partial<AnalysisBudget> = {
          url,
          jobId,
          browser,
          config: browserConfig,
          checkMobileViewport: config.checkMobileViewport,
          budgetMs: budget.budgetMs,
          deadlineAt: budget.deadlineAt,
          signal: budget.signal,
          linkCheck: {
            enabled: config.checkLinks,
            maxLinks: config.maxLinkChecks,
            timeoutMs: 5000,
            concurrency: 5,
            sameOriginOnly: true,
            isAllowedUrl: (candidate) => isAllowedUrl(candidate, { allowPrivateHosts: config.allowPrivateHosts }),
          },
        };

        return analyzeLandingPage(request);
      },
    },
    {
      // The server owns the signal handlers and the drain. The browser is only
      // closed once that drain has finished, so a redeploy can never pull it
      // out from under a capture that is still running.
      onShutdown: async (signal) => {
        logger.info(`${signal}: closing the browser`);
        await browsers.close();
      },
    },
  );
}

function browserUnavailable(cause: unknown): Error {
  const error = new Error("The browser could not be launched.", { cause }) as Error & { code: string };
  error.code = "browser_unavailable";
  return error;
}

const isEntryPoint = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (isEntryPoint) {
  main().catch((error) => {
    logger.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
