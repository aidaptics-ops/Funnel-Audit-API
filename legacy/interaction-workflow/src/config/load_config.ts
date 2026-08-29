import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CrawlConfig, TestIdentity } from "../types/index.js";

const DEFAULTS: Omit<CrawlConfig, "start_url"> = {
  max_pages: 15,
  headless: false,
  device: "desktop",
  submit_forms: true,
  submit_booking: true,
  submit_checkout: false,
  output_dir: "results",
  screenshot_dir: "results",
  timeout_ms: 30000,
  navigation_timeout_ms: 30000,
  manual_mode: true,
  manual_form_timeout_ms: 900000,
  manual_booking_timeout_ms: 900000,
  operator_prompt: true,
};

interface FileConfig {
  start_url?: string;
  test_identity?: TestIdentity;
  max_pages?: number;
  headless?: boolean;
  device?: "desktop" | "mobile";
  submit_forms?: boolean;
  submit_booking?: boolean;
  submit_checkout?: boolean;
  output_dir?: string;
  screenshot_dir?: string;
  timeout_ms?: number;
  navigation_timeout_ms?: number;
  manual_mode?: boolean;
  manual_form_timeout_ms?: number;
  manual_booking_timeout_ms?: number;
  operator_prompt?: boolean;
}

export interface CliArgs {
  url?: string;
  config?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  maxPages?: number;
  headless?: boolean;
  device?: "desktop" | "mobile";
  submitForms?: boolean;
  manualMode?: boolean;
  manualTimeoutMs?: number;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    switch (token) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--url":
      case "-u":
        args.url = next;
        i += 1;
        break;
      case "--config":
      case "-c":
        args.config = next;
        i += 1;
        break;
      case "--email":
        args.email = next;
        i += 1;
        break;
      case "--phone":
        args.phone = next;
        i += 1;
        break;
      case "--first-name":
        args.firstName = next;
        i += 1;
        break;
      case "--last-name":
        args.lastName = next;
        i += 1;
        break;
      case "--max-pages":
        args.maxPages = Number(next);
        i += 1;
        break;
      case "--device":
        args.device = next === "mobile" ? "mobile" : "desktop";
        i += 1;
        break;
      case "--headless":
      case "--headless=true":
        args.headless = next === "false" ? false : true;
        if (next === "true" || next === "false") i += 1;
        break;
      case "--headed":
        args.headless = false;
        break;
      case "--no-submit":
        args.submitForms = false;
        break;
      case "--manual":
        args.manualMode = true;
        break;
      case "--auto":
      case "--automatic":
        args.manualMode = false;
        break;
      case "--manual-timeout":
        args.manualTimeoutMs = Number(next) * 1000;
        i += 1;
        break;
      default:
        if (!token.startsWith("-")) rest.push(token);
        break;
    }
  }

  if (!args.url && rest[0]) args.url = rest[0];
  return args;
}

export function loadEnvFile(cwd = process.cwd()): Record<string, string> {
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

function envVal(fileEnv: Record<string, string>, key: string): string | undefined {
  const fromFile = fileEnv[key]?.trim();
  if (fromFile) return fromFile;
  const fromProcess = process.env[key]?.trim();
  return fromProcess || undefined;
}

export function loadConfig(args: CliArgs, cwd = process.cwd()): CrawlConfig {
  const fileEnv = loadEnvFile(cwd);
  let fileConfig: FileConfig = {};

  if (args.config) {
    const path = resolve(cwd, args.config);
    fileConfig = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  }

  const startUrl =
    args.url ||
    fileConfig.start_url ||
    envVal(fileEnv, "FUNNEL_START_URL") ||
    "";

  if (!startUrl) {
    throw new Error(
      "A start URL is required. Pass a URL, set FUNNEL_START_URL in .env, or use --config.",
    );
  }

  const identity: TestIdentity = {
    first_name:
      args.firstName ||
      fileConfig.test_identity?.first_name ||
      envVal(fileEnv, "TEST_FIRST_NAME"),
    last_name:
      args.lastName ||
      fileConfig.test_identity?.last_name ||
      envVal(fileEnv, "TEST_LAST_NAME"),
    email: args.email || fileConfig.test_identity?.email || envVal(fileEnv, "TEST_EMAIL"),
    phone: args.phone || fileConfig.test_identity?.phone || envVal(fileEnv, "TEST_PHONE"),
  };

  const hasIdentity = Boolean(identity.email || identity.phone || identity.first_name);

  const envHeadless = envVal(fileEnv, "FUNNEL_HEADLESS");
  const envSubmit = envVal(fileEnv, "FUNNEL_SUBMIT_FORMS");
  const envManual = envVal(fileEnv, "FUNNEL_MANUAL_MODE");
  const envOperatorPrompt = envVal(fileEnv, "FUNNEL_OPERATOR_PROMPT");
  const manualMode =
    args.manualMode ?? fileConfig.manual_mode ?? (envManual ? envManual === "true" : DEFAULTS.manual_mode);
  const manualTimeout = args.manualTimeoutMs;

  return {
    start_url: startUrl,
    manual_mode: manualMode,
    manual_form_timeout_ms:
      manualTimeout ??
      fileConfig.manual_form_timeout_ms ??
      numberFromEnv(envVal(fileEnv, "FUNNEL_MANUAL_FORM_TIMEOUT_MS"), DEFAULTS.manual_form_timeout_ms),
    manual_booking_timeout_ms:
      manualTimeout ??
      fileConfig.manual_booking_timeout_ms ??
      numberFromEnv(envVal(fileEnv, "FUNNEL_MANUAL_BOOKING_TIMEOUT_MS"), DEFAULTS.manual_booking_timeout_ms),
    operator_prompt:
      fileConfig.operator_prompt ??
      (envOperatorPrompt ? envOperatorPrompt === "true" : DEFAULTS.operator_prompt),
    test_identity: hasIdentity ? identity : undefined,
    max_pages: args.maxPages ?? fileConfig.max_pages ?? Number(envVal(fileEnv, "FUNNEL_MAX_PAGES") || DEFAULTS.max_pages),
    // Manual mode needs a window a human can actually use.
    headless: manualMode
      ? false
      : (args.headless ??
        fileConfig.headless ??
        (envHeadless ? envHeadless === "true" : DEFAULTS.headless)),
    device:
      args.device ??
      fileConfig.device ??
      (envVal(fileEnv, "FUNNEL_DEVICE") === "mobile" ? "mobile" : "desktop"),
    submit_forms:
      args.submitForms ??
      fileConfig.submit_forms ??
      (envSubmit ? envSubmit === "true" : DEFAULTS.submit_forms),
    submit_booking:
      fileConfig.submit_booking ??
      (envVal(fileEnv, "FUNNEL_SUBMIT_BOOKING") === "false" ? false : DEFAULTS.submit_booking),
    submit_checkout: fileConfig.submit_checkout ?? DEFAULTS.submit_checkout,
    output_dir: fileConfig.output_dir ?? DEFAULTS.output_dir,
    screenshot_dir: fileConfig.screenshot_dir ?? DEFAULTS.screenshot_dir,
    timeout_ms: fileConfig.timeout_ms ?? DEFAULTS.timeout_ms,
    navigation_timeout_ms: fileConfig.navigation_timeout_ms ?? DEFAULTS.navigation_timeout_ms,
  };
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function identityIsUsable(identity?: TestIdentity): boolean {
  if (!identity) return false;
  return Boolean(identity.email || identity.phone);
}

export function helpText(): string {
  return `
Funnel evidence crawler

Usage:
  npm run crawl
  npm run crawl -- <url>
  npm run crawl -- --url <url> [--auto] [--manual-timeout 900]
  npm run crawl -- --config config.json

If no URL is passed, FUNNEL_START_URL and TEST_* values are read from .env.

Modes:
  --manual (default)  Crawl and analyse automatically; pause for a human at the
                      form and at the scheduler, then resume on the confirmation
                      page. The browser is always visible in this mode.
  --auto              Legacy mode: fill and submit forms with the test identity
                      and attempt the booking automatically.

Options:
  --url, -u           Funnel start URL
  --config, -c        JSON config file
  --manual-timeout    Seconds to wait at each manual step (default 900)
  --email             Test email (auto mode: enables form submission)
  --phone             Test phone
  --first-name        Test first name
  --last-name         Test last name
  --max-pages         Maximum pages to visit (default 15)
  --device            desktop | mobile (default desktop)
  --headless          Run headless (auto mode only)
  --headed            Run with a visible browser
  --no-submit         Never submit forms, even if credentials exist
  --help              Show this message

In auto mode, forms are submitted when a test email or phone is supplied
(and --no-submit is not set). Checkout is never submitted unless explicitly
enabled in the config JSON.

Each run writes results/<run-id>/ with manifest.json, landing_page.json,
confirmation_page.json, forms.json, issues.json, analysis.json, events.json,
report.json, pages/ and screenshots/.
`.trim();
}
