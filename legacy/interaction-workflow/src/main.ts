import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helpText, loadConfig, parseArgs } from "./config/load_config.js";
import { funnelIdFromUrl, uniqueCrawlId } from "./output/crawl_id.js";
import { BrowserManager } from "./browser/browser_manager.js";
import { ContextManager } from "./browser/context_manager.js";
import { FunnelNavigator, type ManualHooks, type NavigatorOutcome } from "./crawler/funnel_navigator.js";
import { EmbedEventBus } from "./crawler/embed_events.js";
import { RunStateMachine } from "./crawler/run_state.js";
import { prepareIdentity } from "./crawler/dummy_answers.js";
import { logger } from "./logging/logger.js";
import { printRunSummary } from "./output/report_writer.js";
import { RunStore } from "./output/run_store.js";
import { ScreenshotManager } from "./screenshots/screenshot_manager.js";
import { allIssues, buildDataset, businessNameFrom, formsWithPageContext } from "./analysis/funnel_summary.js";
import { countBySeverity } from "./analysis/issue_detector.js";
import { CRAWLER_VERSION } from "./version.js";
import {
  ANALYSIS_SCHEMA_VERSION,
  type CrawlConfig,
  type CrawlReport,
  type FunnelMetadata,
  type PageAnalysis,
  type RunManifest,
} from "./types/index.js";

export interface RunResult {
  code: number;
  run_id: string;
  dir: string;
  manifest: RunManifest;
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(helpText());
    return 0;
  }

  let config: CrawlConfig;
  try {
    config = loadConfig(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.log(`\n${helpText()}`);
    return 1;
  }

  const result = await runWithConfig(config);
  return result.code;
}

export async function runWithConfig(config: CrawlConfig, hooks?: ManualHooks): Promise<RunResult> {
  if (config.test_identity) config.test_identity = prepareIdentity(config.test_identity);

  const runId = uniqueCrawlId(config.start_url, [config.output_dir]);
  const funnelId = funnelIdFromUrl(config.start_url);
  const store = new RunStore(config.output_dir, runId, funnelId);
  const screenshots = new ScreenshotManager(store.screenshotDir);
  const browserManager = new BrowserManager();
  const contextManager = new ContextManager();
  const state = new RunStateMachine();
  const events = new EmbedEventBus();
  const startedAt = new Date();

  const metadata: FunnelMetadata = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    run_id: runId,
    funnel_id: funnelId,
    funnel_url: config.start_url,
    funnel_host: hostOf(config.start_url),
    business_name: null,
    device: config.device,
    mode: config.manual_mode ? "manual" : "automatic",
    crawler_version: CRAWLER_VERSION,
    captured_at: startedAt.toISOString(),
  };

  const live = {
    analyses: [] as PageAnalysis[],
    outcome: null as NavigatorOutcome | null,
    notes: [] as string[],
  };

  const buildManifest = (): RunManifest => {
    const outcome = live.outcome;
    const issues = allIssues(live.analyses);
    const report = outcome?.report;
    return {
      schema_version: ANALYSIS_SCHEMA_VERSION,
      run_id: runId,
      funnel_id: funnelId,
      funnel_url: config.start_url,
      funnel_host: metadata.funnel_host,
      business_name: metadata.business_name,
      mode: metadata.mode,
      device: config.device,
      crawler_version: CRAWLER_VERSION,
      state: state.state,
      status: report?.status ?? (state.state === "FAILED" ? "failed" : "partial"),
      started_at: startedAt.toISOString(),
      finished_at: report ? report.finished_at : null,
      duration_ms: report ? new Date(report.finished_at).getTime() - startedAt.getTime() : null,
      milestones:
        outcome?.milestones ?? {
          landing_analyzed: false,
          form_located: false,
          form_submitted: false,
          scheduling_detected: false,
          booking_confirmed: false,
          confirmation_analyzed: false,
        },
      state_history: state.transitions,
      manual_gates: outcome?.manual_gates ?? [],
      counts: {
        pages: live.analyses.length,
        forms: new Set(live.analyses.flatMap((page) => page.forms.items.map((form) => form.form_id))).size,
        screenshots: screenshots.all().length,
        errors: report?.errors.length ?? 0,
        issues: issues.length,
        issues_by_severity: countBySeverity(issues),
      },
      artifacts: {
        manifest: "manifest.json",
        landing_page: "landing_page.json",
        confirmation_page: "confirmation_page.json",
        forms: "forms.json",
        issues: "issues.json",
        analysis: "analysis.json",
        events: "events.json",
        report: "report.json",
        pages: "pages/",
        screenshots: "screenshots/",
      },
      notes: [...live.notes, ...(report?.notes ?? [])],
    };
  };

  // Persist the manifest on every state change so a killed run is still readable.
  state.onTransition(() => {
    try {
      store.saveManifest(buildManifest());
    } catch {
      // storage errors are already logged by RunStore
    }
  });

  logger.info(`Run ${runId} (${metadata.mode} mode) starting for ${config.start_url}`);
  if (config.manual_mode) {
    logger.info("Manual mode: the crawler will pause for you at the form and at the scheduler.");
  } else if (config.test_identity?.email) {
    logger.info(`Test identity email ${config.test_identity.email}`);
  }
  store.saveManifest(buildManifest());

  try {
    const browser = await browserManager.launch(config);
    await contextManager.create(browser, config, events);
    const page = await contextManager.newPage();

    const navigator = new FunnelNavigator(config, screenshots, runId, {
      state,
      metadata,
      events,
      hooks,
      onPageAnalyzed: (analysis) => {
        live.analyses.push(analysis);
        try {
          store.savePage(analysis);
        } catch {
          // already logged
        }
      },
    });

    const outcome = await navigator.run(page);
    live.outcome = outcome;
    metadata.business_name = businessNameFrom(outcome.landing_record);
    if (outcome.landing) outcome.landing.funnel_metadata.business_name = metadata.business_name;

    writeArtifacts(store, config, metadata, state, outcome, buildManifest());
    const manifest = buildManifest();
    printRunSummary(manifest, outcome, store.dir);
    return {
      code: outcome.report.status === "failed" ? 1 : 0,
      run_id: runId,
      dir: store.dir,
      manifest,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Fatal: ${message}`);
    live.notes.push(`fatal: ${message}`);
    if (state.state !== "FAILED") state.transition("FAILED", { note: message });

    const failedReport: CrawlReport = {
      crawl_id: runId,
      start_url: config.start_url,
      status: "failed",
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      device: config.device,
      business: { name: metadata.business_name, owner: null },
      funnel_path: [],
      pages: [],
      interactions: [],
      screenshots: screenshots.all(),
      errors: [{ stage: "fatal", error: message, timestamp: new Date().toISOString() }],
      notes: live.notes,
    };
    store.saveReport(failedReport);
    store.saveConfirmationPage(null, `run failed: ${message}`);
    const manifest = buildManifest();
    store.saveManifest(manifest);
    console.error(`Partial/failed run written to ${store.dir}`);
    return { code: 1, run_id: runId, dir: store.dir, manifest };
  } finally {
    await contextManager.close();
    await browserManager.close();
  }
}

function writeArtifacts(
  store: RunStore,
  config: CrawlConfig,
  metadata: FunnelMetadata,
  state: RunStateMachine,
  outcome: NavigatorOutcome,
  manifest: RunManifest,
): void {
  const pages = outcome.analyses;
  const issues = allIssues(pages);
  const generatedAt = new Date().toISOString();

  store.saveReport(outcome.report);
  if (outcome.landing) store.saveLandingPage(outcome.landing);
  store.saveConfirmationPage(
    outcome.confirmation,
    outcome.confirmation_reason || "the funnel run did not reach a confirmation page",
  );

  store.saveForms({
    run_id: metadata.run_id,
    funnel_id: metadata.funnel_id,
    generated_at: generatedAt,
    total: formsWithPageContext(pages).length,
    forms: formsWithPageContext(pages),
  });

  const dataset = buildDataset({
    metadata,
    run: {
      run_id: metadata.run_id,
      state: state.state,
      status: outcome.report.status,
      started_at: outcome.report.started_at,
      finished_at: outcome.report.finished_at,
      milestones: outcome.milestones,
      manual_gates: outcome.manual_gates,
    },
    funnel_path: outcome.report.funnel_path,
    landing: outcome.landing,
    confirmation: outcome.confirmation,
    intermediate: pages.filter(
      (page) => page !== outcome.landing && page !== outcome.confirmation,
    ),
    scheduling: outcome.scheduling,
    confirmation_reason: outcome.confirmation_reason,
    blocked: outcome.blocked,
    errors: outcome.report.errors.length,
    limitations: limitationsFrom(outcome),
  });

  store.saveIssues({
    run_id: metadata.run_id,
    funnel_id: metadata.funnel_id,
    generated_at: generatedAt,
    total: issues.length,
    by_severity: countBySeverity(issues),
    issues,
    recommendations: dataset.recommendations,
  });

  store.saveAnalysis(dataset);
  store.saveEvents({
    run_id: metadata.run_id,
    state_history: state.transitions,
    manual_gates: outcome.manual_gates,
    interactions: outcome.report.interactions,
    errors: outcome.report.errors,
    notes: outcome.report.notes,
  });
  store.saveManifest(manifest);
  void config;
}

function limitationsFrom(outcome: NavigatorOutcome): string[] {
  const limitations: string[] = [];
  if (outcome.blocked) limitations.push("An anti-bot or access-denied page was captured instead of funnel content.");
  if (!outcome.confirmation) {
    limitations.push(outcome.confirmation_reason || "No confirmation page was captured.");
  }
  if (outcome.scheduling.detected && !outcome.scheduling.booked) {
    limitations.push("A scheduling step was detected but no booking confirmation was observed.");
  }
  for (const gate of outcome.manual_gates) {
    if (gate.status === "timeout") limitations.push(`Manual ${gate.kind} timed out after ${gate.waited_ms}ms.`);
    if (gate.status === "operator_skipped") limitations.push(`Operator skipped the manual ${gate.kind} step.`);
  }
  const videoLimits = outcome.landing?.videos.limitations ?? [];
  limitations.push(...videoLimits);
  return [...new Set(limitations)];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const self = fileURLToPath(import.meta.url);
if (self === invoked || /[/\\]src[/\\]main\.ts$/.test(invoked) || /[/\\]dist[/\\]main\.js$/.test(invoked)) {
  run().then((code) => process.exit(code));
}
