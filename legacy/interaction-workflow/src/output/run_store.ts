import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logging/logger.js";
import type {
  AnalyzedForm,
  CrawlReport,
  DetectedIssue,
  FunnelDataset,
  PageAnalysis,
  Recommendation,
  RunEvents,
  RunManifest,
} from "../types/index.js";

export const ARTIFACTS = {
  manifest: "manifest.json",
  landing: "landing_page.json",
  confirmation: "confirmation_page.json",
  forms: "forms.json",
  issues: "issues.json",
  analysis: "analysis.json",
  events: "events.json",
  report: "report.json",
  pages: "pages",
  screenshots: "screenshots",
} as const;

export interface IssuesFile {
  run_id: string;
  funnel_id: string;
  generated_at: string;
  total: number;
  by_severity: Record<string, number>;
  issues: DetectedIssue[];
  recommendations: Recommendation[];
}

export interface FormsFile {
  run_id: string;
  funnel_id: string;
  generated_at: string;
  total: number;
  forms: Array<AnalyzedForm & { page_url: string; page_role: string }>;
}

/**
 * One directory per run, one file per concern. Every write is atomic, so a
 * crash mid-run leaves the already-written artifacts intact and never mixes
 * two funnels in one file.
 */
export class RunStore {
  readonly dir: string;
  readonly screenshotDir: string;
  readonly pageDir: string;

  constructor(
    outputDir: string,
    readonly runId: string,
    readonly funnelId: string,
  ) {
    this.dir = join(outputDir, runId);
    this.screenshotDir = join(this.dir, ARTIFACTS.screenshots);
    this.pageDir = join(this.dir, ARTIFACTS.pages);
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.screenshotDir, { recursive: true });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  saveManifest(manifest: RunManifest): string {
    return this.write(ARTIFACTS.manifest, manifest);
  }

  saveLandingPage(analysis: PageAnalysis): string {
    return this.write(ARTIFACTS.landing, analysis);
  }

  /** Always written, so downstream consumers can rely on the file existing. */
  saveConfirmationPage(analysis: PageAnalysis | null, reason?: string): string {
    if (analysis) return this.write(ARTIFACTS.confirmation, analysis);
    return this.write(ARTIFACTS.confirmation, {
      reached: false,
      reason: reason || "the funnel run did not reach a confirmation page",
      run_id: this.runId,
      funnel_id: this.funnelId,
      generated_at: new Date().toISOString(),
    });
  }

  savePage(analysis: PageAnalysis): string {
    mkdirSync(this.pageDir, { recursive: true });
    const sequence = String(analysis.page_information.sequence).padStart(3, "0");
    const role = analysis.page_information.page_role;
    const type = analysis.page_information.page_type.replace(/[^a-z0-9_]/gi, "_");
    return this.write(join(ARTIFACTS.pages, `${sequence}_${role}_${type}.json`), analysis);
  }

  saveForms(file: FormsFile): string {
    return this.write(ARTIFACTS.forms, file);
  }

  saveIssues(file: IssuesFile): string {
    return this.write(ARTIFACTS.issues, file);
  }

  saveAnalysis(dataset: FunnelDataset): string {
    return this.write(ARTIFACTS.analysis, dataset);
  }

  saveEvents(events: RunEvents): string {
    return this.write(ARTIFACTS.events, events);
  }

  /** Full raw evidence, kept for backwards compatibility with earlier runs. */
  saveReport(report: CrawlReport): string {
    return this.write(ARTIFACTS.report, report);
  }

  private write(name: string, payload: unknown): string {
    const target = join(this.dir, name);
    const temp = `${target}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      if (existsSync(target)) rmSync(target, { force: true });
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      logger.error(`Failed to write ${name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return target;
  }
}
