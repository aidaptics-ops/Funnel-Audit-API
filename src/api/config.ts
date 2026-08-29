export interface ApiConfig {
  port: number;
  host: string;
  maxConcurrentAnalyses: number;
  browserTimeoutMs: number;
  navigationTimeoutMs: number;
  totalAnalysisTimeoutMs: number;
  browserChannel: string;
  headless: boolean;
  /** Second, mobile-viewport pass. Costs an extra page load. */
  checkMobileViewport: boolean;
  checkLinks: boolean;
  maxLinkChecks: number;
  allowPrivateHosts: boolean;
  logLevel: string;
}

type Env = NodeJS.ProcessEnv;

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "no", "n", "off"]);

/**
 * Reads the deployment configuration from the environment. A malformed value is
 * never fatal: the service must still boot on a host with a typo in its env, so
 * every reader falls back to the documented default instead of throwing.
 */
export function loadApiConfig(env: Env = process.env): ApiConfig {
  return {
    port: readPositiveInt(env, "PORT", 3000),
    host: readString(env, "HOST", "0.0.0.0") || "0.0.0.0",
    maxConcurrentAnalyses: readPositiveInt(env, "MAX_CONCURRENT_ANALYSES", 2),
    browserTimeoutMs: readPositiveInt(env, "BROWSER_TIMEOUT_MS", 30000),
    navigationTimeoutMs: readPositiveInt(env, "NAVIGATION_TIMEOUT_MS", 30000),
    totalAnalysisTimeoutMs: readPositiveInt(env, "ANALYSIS_TIMEOUT_MS", 120000),
    browserChannel: readString(env, "BROWSER_CHANNEL", ""),
    // FUNNEL_HEADLESS is the name the original crawler used; it is still
    // honoured so existing deployment configs keep working.
    headless: readBool(env, "HEADLESS", readBool(env, "FUNNEL_HEADLESS", true)),
    // CAPTURE_MOBILE_SCREENSHOT is the old name for the same pass; honoured
    // so existing deployment configs keep working.
    checkMobileViewport: readBool(env, "CHECK_MOBILE_VIEWPORT", readBool(env, "CAPTURE_MOBILE_SCREENSHOT", true)),
    checkLinks: readBool(env, "CHECK_LINKS", true),
    maxLinkChecks: readPositiveInt(env, "MAX_LINK_CHECKS", 25),
    allowPrivateHosts: readBool(env, "ALLOW_PRIVATE_HOSTS", false),
    logLevel: readEnum(env, "LOG_LEVEL", LOG_LEVELS, "info"),
  };
}

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return typeof raw === "string" ? raw.trim() : fallback;
}

function readPositiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fallback;
}

function readEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const value = readString(env, key, "").toLowerCase();
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
