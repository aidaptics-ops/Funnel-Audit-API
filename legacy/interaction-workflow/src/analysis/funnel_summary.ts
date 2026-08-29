import { ANALYSIS_SCHEMA_VERSION } from "../types/index.js";
import type {
  AnalyzedForm,
  CrawlStatus,
  DetectedIssue,
  FunnelDataset,
  FunnelMetadata,
  FunnelStep,
  ManualGateResult,
  PageAnalysis,
  PageRecord,
  RunMilestones,
  RunState,
} from "../types/index.js";
import { sortIssues } from "./issue_detector.js";
import { recommendationsFor } from "./recommendations.js";

export interface DatasetInput {
  metadata: FunnelMetadata;
  run: {
    run_id: string;
    state: RunState;
    status: CrawlStatus;
    started_at: string;
    finished_at: string | null;
    milestones: RunMilestones;
    manual_gates: ManualGateResult[];
  };
  funnel_path: FunnelStep[];
  landing: PageAnalysis | null;
  confirmation: PageAnalysis | null;
  intermediate: PageAnalysis[];
  scheduling: { detected: boolean; provider: string | null; booked: boolean };
  confirmation_reason: string | null;
  blocked: boolean;
  errors: number;
  limitations: string[];
}

export function buildDataset(input: DatasetInput): FunnelDataset {
  const pages = [input.landing, ...input.intermediate, input.confirmation].filter(
    (page): page is PageAnalysis => Boolean(page),
  );
  const issues = sortIssues(pages.flatMap((page) => page.detected_issues));

  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    funnel_metadata: input.metadata,
    run: input.run,
    funnel_path: input.funnel_path,
    landing_page: input.landing,
    confirmation_page: input.confirmation,
    intermediate_pages: input.intermediate,
    forms: collectForms(pages),
    scheduling: {
      detected: input.scheduling.detected,
      provider: input.scheduling.provider,
      booked: input.scheduling.booked,
      appointment: input.confirmation?.confirmation_details?.appointment ?? null,
    },
    issues,
    recommendations: recommendationsFor(issues),
    offer_summary: offerSummary(input.landing, input.confirmation),
    data_quality: {
      landing_page_captured: Boolean(input.landing),
      confirmation_page_captured: Boolean(input.confirmation),
      confirmation_reason: input.confirmation_reason,
      blocked: input.blocked,
      errors: input.errors,
      limitations: input.limitations,
    },
  };
}

export function collectForms(pages: PageAnalysis[]): AnalyzedForm[] {
  const seen = new Set<string>();
  const forms: AnalyzedForm[] = [];
  for (const page of pages) {
    for (const form of page.forms.items) {
      const key = `${form.integration.provider}|${form.action || form.selector || form.form_id}|${form.field_count}`;
      if (seen.has(key)) continue;
      seen.add(key);
      forms.push(form);
    }
  }
  return forms;
}

export function formsWithPageContext(
  pages: PageAnalysis[],
): Array<AnalyzedForm & { page_url: string; page_role: string }> {
  const rows: Array<AnalyzedForm & { page_url: string; page_role: string }> = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const form of page.forms.items) {
      const key = `${form.integration.provider}|${form.action || form.selector || form.form_id}|${form.field_count}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...form,
        page_url: page.page_information.url,
        page_role: page.page_information.page_role,
      });
    }
  }
  return rows;
}

export function allIssues(pages: PageAnalysis[]): DetectedIssue[] {
  return sortIssues(pages.flatMap((page) => page.detected_issues));
}

function offerSummary(
  landing: PageAnalysis | null,
  confirmation: PageAnalysis | null,
): FunnelDataset["offer_summary"] {
  const copy = landing?.page_structure.key_copy;
  const proof = [
    ...new Set(
      [
        ...(landing?.conversion_elements.testimonials || []).map((item) => item.text),
        ...(landing?.conversion_elements.social_proof || []).map((item) => item.text),
      ].filter(Boolean),
    ),
  ].slice(0, 10);

  const audience = [
    ...(landing?.conversion_elements.objection_handling || []).map((item) => `${item.topic}: ${item.text}`),
    ...(landing?.conversion_elements.benefit_stack || []).map((item) => item.text),
  ].slice(0, 12);

  return {
    headline: copy?.headline ?? null,
    subheadline: copy?.subheadline ?? null,
    promise: landing?.ctas.primary?.stated_outcome ?? copy?.offer ?? null,
    price_points: (landing?.conversion_elements.pricing || [])
      .map((price) => price.amount || price.text)
      .filter((value): value is string => Boolean(value))
      .slice(0, 8),
    proof_points: proof,
    audience_signals: audience,
    key_copy: [
      ...(copy?.top_paragraphs || []).slice(0, 8),
      ...(confirmation?.confirmation_details?.next_steps || []).slice(0, 4),
    ],
  };
}

/** Business name from structured data, then the title, then the hostname. */
export function businessNameFrom(record: PageRecord | null): string | null {
  if (!record) return null;

  const fromJsonLd = findOrganizationName(record.json_ld);
  if (fromJsonLd) return fromJsonLd;

  const title = record.title || "";
  const parts = title
    .split(/[|–—]|(?: - )/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const candidate = parts[parts.length - 1];
    if (candidate.length >= 2 && candidate.length <= 60) return candidate;
  }

  try {
    return new URL(record.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function findOrganizationName(nodes: unknown[]): string | null {
  let found: string | null = null;
  const visit = (node: unknown): void => {
    if (found || !node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    const types = Array.isArray(type) ? type.map(String) : typeof type === "string" ? [type] : [];
    if (types.some((value) => /Organization|LocalBusiness|Person|WebSite/i.test(value))) {
      const name = obj.name ?? obj.legalName;
      if (typeof name === "string" && name.trim()) {
        found = name.trim();
        return;
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  nodes.forEach(visit);
  return found;
}
