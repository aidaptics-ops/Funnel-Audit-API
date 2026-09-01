import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LandingAnalysis } from "../analysis/landing_types.js";
import { logger } from "../logging/logger.js";
import { SERVICE_VERSION } from "../version.js";
import type { ApiConfig } from "./config.js";
import { Semaphore, TimeoutError, withTimeout } from "./concurrency.js";
import { validateTargetUrl } from "./url_guard.js";

/**
 * What the HTTP layer still allows this analysis. The pipeline owns its own
 * deadline; without this it would have no idea the client is already gone.
 */
export interface AnalysisBudget {
  /** Milliseconds of wall clock left before the server stops waiting. */
  budgetMs: number;
  /** The same limit as an epoch timestamp, for code that compares to Date.now(). */
  deadlineAt: number;
  /** Aborted when the budget is spent, so the capture can unwind itself. */
  signal: AbortSignal;
}

/** Per-request switches a caller may set in the request body. */
export interface AnalyzeRequestOptions {
  /**
   * Return strips of the rendered page alongside the structured reading.
   *
   * Opt-in because the images dominate the response size, and only a caller
   * that will show them to a vision model has any use for them.
   */
  screenshot: boolean;
  /**
   * How much of the audit to run. "full" is everything; "light" keeps the
   * evidence and drops the mobile pass, the link check and most of the
   * screenshot — what a caller wants for the second page of a funnel, where the
   * question is what the page is rather than how well it converts.
   *
   * Page-agnostic by design: it changes the crawler's effort, never its
   * conclusions. An unrecognised value is "full", never an error, so a typo in
   * an optional switch cannot cost a caller their analysis.
   */
  captureProfile: "full" | "light";
}

/** Anything that is not exactly "light" is the full audit. */
function readCaptureProfile(body: unknown): "full" | "light" {
  if (!isRecord(body)) return "full";
  return body.capture_profile === "light" ? "light" : "full";
}

export interface ServerDeps {
  analyze: (
    url: string,
    jobId: string,
    budget: AnalysisBudget,
    request: AnalyzeRequestOptions,
  ) => Promise<LandingAnalysis>;
}

/** Runs after the HTTP drain, before the process is allowed to exit. */
export interface StartServerOptions {
  /**
   * Where the browser is closed. It runs only once the drain has finished, so
   * a shutdown can never tear the browser down under a running capture.
   */
  onShutdown?: (signal: string) => Promise<void> | void;
  /** Set false when the caller owns process signals (tests, embedding). */
  handleSignals?: boolean;
  /** Set false to keep the process alive after a drain (tests). */
  exitOnShutdown?: boolean;
}

/** A JSON body larger than this is never a legitimate analyse request. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * How much a body we have already rejected may keep streaming before the socket
 * is cut. Draining is what lets the client read our error, but an unbounded
 * drain would let one client feed us gigabytes it knows we will throw away.
 */
const MAX_DISCARD_BYTES = MAX_BODY_BYTES * 4;

/**
 * The drain must finish inside the platform's kill grace (Render and
 * Kubernetes both default to about 30s). A drain that outlives the grace ends
 * in a SIGKILL, which is exactly the dropped connection it exists to prevent.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;

/** Extra time after the drain deadline before the process is forced out. */
const HARD_EXIT_MARGIN_MS = 5_000;

/** How long a client may take to finish sending its request body. */
const BODY_READ_TIMEOUT_MS = 15_000;

/** Longest a queued request waits for a free analysis slot before a 429. */
const MAX_QUEUE_WAIT_MS = 30_000;

/** Queue depth, as a multiple of the concurrency limit, before shedding load. */
const MAX_QUEUE_DEPTH_FACTOR = 4;

const HTTP_STATUS_BY_CODE: Record<string, number> = {
  invalid_url: 400,
  unsupported_scheme: 400,
  private_host: 400,
  credentials_not_allowed: 400,
  url_too_long: 400,
  // The URL guard rejects a host that will not resolve. Without this row it
  // fell through to 500, which tells a caller the service broke when in fact
  // the address they submitted does not exist.
  dns_resolution_failed: 400,
  invalid_body: 400,
  blocked_navigation: 400,
  not_found: 404,
  body_too_large: 413,
  analysis_timeout: 408,
  too_many_requests: 429,
  navigation_failed: 502,
  service_unavailable: 503,
  browser_unavailable: 503,
  internal_error: 500,
};

interface ServerControls {
  shutdown: (signal: string) => Promise<void>;
}

const CONTROLS = new WeakMap<http.Server, ServerControls>();

/**
 * Drains and closes a server created here. Signal handlers must go through
 * this single owner: a second handler closing the browser (or the process)
 * mid-drain is what turns a redeploy into dropped connections.
 */
export function shutdownServer(server: http.Server, signal: string): Promise<void> {
  const controls = CONTROLS.get(server);
  if (controls) return controls.shutdown(signal);
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export function createServer(config: ApiConfig, deps: ServerDeps): http.Server {
  const bootedAt = Date.now();
  const semaphore = new Semaphore(config.maxConcurrentAnalyses);
  const graceMs = readShutdownGraceMs();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      // A throw out of the router is a bug in this file, never the client's
      // problem to debug: log it in full, answer with the generic envelope.
      logger.error(`Unhandled request error: ${describe(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { status: "failed", error: { code: "internal_error", message: "The request failed." } });
      } else {
        res.end();
      }
    });
  });

  // Caps how long a client may hold a connection while sending a request. It
  // does not limit the response, so a long analysis is unaffected.
  server.requestTimeout = BODY_READ_TIMEOUT_MS + 15_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(res);

    // The cap is checked before anything routes or parses, so a body aimed at
    // an unrouted path (or sent with a content-type we never parse) is refused
    // on the same terms as one aimed at /analyze.
    if (declaredTooLarge(req)) {
      rejectTooLarge(req, res, randomUUID());
      return;
    }

    if (req.method === "OPTIONS") {
      discardBody(req);
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (pathname === "/health" && (method === "GET" || method === "HEAD")) {
      discardBody(req);
      handleHealth(res, method === "HEAD");
      return;
    }

    if (pathname === "/analyze" && method === "POST") {
      await handleAnalyze(req, res);
      return;
    }

    discardBody(req);
    sendFailure(res, randomUUID(), "", "not_found", "No such endpoint.");
  }

  function handleHealth(res: ServerResponse, headOnly: boolean): void {
    const body = {
      status: shuttingDown ? "shutting_down" : "ok",
      version: SERVICE_VERSION,
      uptime_s: Math.round((Date.now() - bootedAt) / 1000),
      active_analyses: semaphore.active,
      queued_analyses: semaphore.queued,
      max_concurrent_analyses: semaphore.limit,
    };
    sendJson(res, shuttingDown ? 503 : 200, body, headOnly);
  }

  async function handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const jobId = randomUUID();

    if (shuttingDown) {
      sendFailure(res, jobId, "", "service_unavailable", "The service is shutting down.");
      return;
    }

    // The body is read before a permit is taken, so a slow client can never
    // occupy one of the few analysis slots.
    const body = await readJsonBody(req);
    if (!body.ok) {
      if (body.code === "body_too_large") {
        rejectTooLarge(req, res, jobId);
        return;
      }
      // The request stream was abandoned mid-flight; closing the connection is
      // the only way to stop the client from sending the rest of it.
      if (body.close) res.setHeader("connection", "close");
      sendFailure(res, jobId, "", body.code, body.message);
      return;
    }

    const rawUrl = isRecord(body.value) ? body.value.url : undefined;
    const check = validateTargetUrl(rawUrl, { allowPrivateHosts: config.allowPrivateHosts });
    if (!check.ok) {
      sendFailure(res, jobId, typeof rawUrl === "string" ? rawUrl : "", check.code, check.message);
      return;
    }

    const target = check.url.toString();

    // Backpressure before queueing: past this depth the wait would outlast any
    // reasonable client, so shed the request now instead of holding its socket.
    if (semaphore.queued >= semaphore.limit * MAX_QUEUE_DEPTH_FACTOR) {
      sendFailure(res, jobId, target, "too_many_requests", "The analyser is busy; retry shortly.");
      return;
    }

    const queueWaitMs = Math.min(config.totalAnalysisTimeoutMs, MAX_QUEUE_WAIT_MS);
    let release: (() => void) | null = null;
    try {
      release = await semaphore.acquire(queueWaitMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        sendFailure(res, jobId, target, "too_many_requests", "The analyser is busy; retry shortly.");
        return;
      }
      throw error;
    }

    logger.info(`[${jobId}] analysing ${redactUrl(check.url)}`);

    const budgetMs = config.totalAnalysisTimeoutMs;
    const controller = new AbortController();
    const work = deps.analyze(
      target,
      jobId,
      { budgetMs, deadlineAt: Date.now() + budgetMs, signal: controller.signal },
      {
        screenshot: isRecord(body.value) && body.value.screenshot === true,
        captureProfile: readCaptureProfile(body.value),
      },
    );

    // Attached before the race so a rejection arriving after we have already
    // answered the client cannot surface as an unhandled rejection.
    const settled = work.then(
      () => undefined,
      () => undefined,
    );

    try {
      const analysis = await withTimeout(work, budgetMs, "analysis_timeout");
      sendJson(res, 200, { status: "completed", job_id: jobId, url: target, analysis });
    } catch (error) {
      const failure = classify(error);
      if (failure.code === "analysis_timeout") {
        // The capture is still holding a browser context; tell it to stop.
        controller.abort(new TimeoutError("The analysis exceeded its time budget."));
        logger.warn(`[${jobId}] answered analysis_timeout; the slot stays held until the capture unwinds`);
      }
      logger.error(`[${jobId}] ${failure.code} for ${redactUrl(check.url)}: ${describe(error)}`);
      sendFailure(res, jobId, target, failure.code, failure.message);
    } finally {
      // Releasing at the timeout would let a timed-out analysis keep its browser
      // context while a new one takes the freed permit, so the limit only holds
      // if the permit outlives the work rather than the response.
      const releasePermit = release;
      void settled.then(() => releasePermit?.());
    }
  }


  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info(`${signal} received; draining ${semaphore.active} in-flight analysis(es)`);

      // The listener stays open for the whole drain. Closing it here is what
      // made /health answer ECONNREFUSED instead of 503, and a platform that
      // cannot health-check us cannot take us out of rotation gracefully.
      // Idle keep-alive sockets are left alone until the drain is over: cutting
      // them here is what makes a platform's health probe see a reset instead
      // of the 503 that tells it to stop sending traffic.
      const deadline = Date.now() + graceMs;
      while (semaphore.active > 0 && Date.now() < deadline) {
        await delay(100);
      }

      if (semaphore.active > 0) {
        logger.warn(`drain deadline reached with ${semaphore.active} analysis(es) still running`);
      }

      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();

      // Keep-alive sockets that are idle but not yet reaped would otherwise
      // hold close() open; give them a moment, then cut whatever is left.
      const socketDeadline = Date.now() + 1_000;
      let open = true;
      void closed.then(() => {
        open = false;
      });
      while (open && Date.now() < socketDeadline) {
        await delay(50);
        server.closeIdleConnections?.();
      }

      server.closeAllConnections?.();
      await closed;
      logger.info("HTTP server closed");
    })();
    return shutdownPromise;
  };

  CONTROLS.set(server, { shutdown });
  return server;
}

export async function startServer(
  config: ApiConfig,
  deps: ServerDeps,
  options: StartServerOptions = {},
): Promise<http.Server> {
  const server = createServer(config, deps);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  // config.port may be 0 (ephemeral), so report what was actually bound.
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  logger.info(`Listening on http://${config.host}:${port}`);

  if (options.handleSignals !== false) {
    installSignalHandlers(server, options);
  }

  return server;
}

/**
 * The one place process signals are handled. Everything a shutdown must do runs
 * in order here — drain, then the caller's teardown (the browser), then exit —
 * because a second handler doing any of it in parallel is what killed
 * in-flight captures on redeploy.
 */
function installSignalHandlers(server: http.Server, options: StartServerOptions): void {
  const hardExitAfterMs = readShutdownGraceMs() + HARD_EXIT_MARGIN_MS;

  const onSignal = (signal: NodeJS.Signals): void => {
    // A capture wedged inside Chromium must not hold the process past the
    // platform's kill grace; this timer guarantees an exit either way.
    const hardExit = setTimeout(() => {
      logger.error(`${signal}: shutdown did not finish in time; forcing exit`);
      process.exit(1);
    }, hardExitAfterMs);
    hardExit.unref();

    void (async () => {
      try {
        await shutdownServer(server, signal);
        await options.onShutdown?.(signal);
      } catch (error) {
        logger.error(`shutdown failed: ${describe(error)}`);
      } finally {
        clearTimeout(hardExit);
        if (options.exitOnShutdown !== false) process.exit(0);
      }
    })();
  };

  // once(): a second signal falls through to the default disposition, which is
  // the operator's way of saying "stop waiting".
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => onSignal(signal));
  }
}

function readShutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_GRACE_MS;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SHUTDOWN_GRACE_MS;
}

/* ------------------------------ request body ----------------------------- */

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; close?: boolean };

/** True when the client has declared a body larger than we will ever accept. */
function declaredTooLarge(req: IncomingMessage): boolean {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > MAX_BODY_BYTES;
}

/**
 * Reads and throws away a body we will never parse. Ignoring it entirely would
 * leave the socket busy until the request timeout, but reading it without a cap
 * would let a client stream unlimited bytes into a route that has already
 * answered — so the request dies the moment it crosses the cap.
 */
function discardBody(req: IncomingMessage, limitBytes = MAX_DISCARD_BYTES): void {
  if (req.readableEnded || req.destroyed) return;
  let seen = 0;
  req.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > limitBytes) req.destroy();
  });
  req.on("error", () => undefined);
  req.resume();
}

function rejectTooLarge(req: IncomingMessage, res: ServerResponse, jobId: string): void {
  res.setHeader("connection", "close");
  sendFailure(res, jobId, "", "body_too_large", "The request body is too large.");
  discardBody(req);

  // The client may still be uploading. end() lets the 413 flush so it can
  // actually be read; the socket is then cut rather than left absorbing bytes.
  const socket = res.socket;
  if (!socket) return;
  const closeSocket = (): void => {
    socket.end();
    const timer = setTimeout(() => socket.destroy(), 250);
    timer.unref();
  };
  if (res.writableFinished) closeSocket();
  else res.once("finish", closeSocket);
}

function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType !== "" && !/^application\/json|^text\/json|\+json/.test(contentType)) {
    discardBody(req);
    return Promise.resolve({ ok: false, code: "invalid_body", message: "Send a JSON body." });
  }

  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (result: BodyResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: "invalid_body",
        message: "The request body was not received in time.",
        close: true,
      });
    }, BODY_READ_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        // finish() detaches this listener; the caller takes over the (bounded)
        // drain so the client can still read the 413.
        finish({ ok: false, code: "body_too_large", message: "The request body is too large.", close: true });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        finish({ ok: false, code: "invalid_body", message: "A JSON body with a url field is required." });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, code: "invalid_body", message: "The request body is not valid JSON." });
      }
    };

    const onError = (): void => {
      finish({ ok: false, code: "invalid_body", message: "The request body could not be read." });
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/* -------------------------------- helpers -------------------------------- */

function applyCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("vary", "origin");
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headOnly = false): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    // An analysis result is per-request and never worth sniffing or storing.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
}

function sendFailure(
  res: ServerResponse,
  jobId: string,
  url: string,
  code: string,
  message: string,
): void {
  sendJson(res, HTTP_STATUS_BY_CODE[code] ?? 500, {
    status: "failed",
    job_id: jobId,
    url,
    error: { code, message },
  });
}

/**
 * Maps an analysis failure onto a public error code. Only navigation failures
 * carry a (sanitised) detail through; anything else is a bug or an internal
 * condition and gets a fixed message so no stack or path can escape.
 */
function classify(error: unknown): { code: string; message: string } {
  if (error instanceof TimeoutError) {
    return { code: "analysis_timeout", message: "The analysis exceeded its time budget." };
  }

  // Matched on the code property, not instanceof: the pipeline's error classes
  // are compared across module boundaries, where a duplicated module instance
  // would make instanceof silently false.
  switch (codeOf(error)) {
    case "analysis_timeout":
      return { code: "analysis_timeout", message: "The analysis exceeded its time budget." };
    case "blocked_navigation":
      return {
        code: "blocked_navigation",
        message: "The target redirected to an address this service will not load.",
      };
    case "navigation_failed":
      return { code: "navigation_failed", message: publicNavigationMessage(error) };
    case "browser_unavailable":
      return { code: "browser_unavailable", message: "The analyser has no browser available." };
    default:
      break;
  }

  if (looksLikeBrowserLaunchFailure(error)) {
    return { code: "browser_unavailable", message: "The analyser has no browser available." };
  }
  return { code: "internal_error", message: "The analysis failed unexpectedly." };
}

/**
 * A browser that will not start is an instance-level fault, not a bad request:
 * reporting it as 503 lets a platform restart or drain the instance. The match
 * is deliberately narrow — only Playwright's launch failures, never a page
 * error — so a broken target page can never be blamed on the browser.
 */
function looksLikeBrowserLaunchFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /browserType\.launch|Failed to launch|Executable doesn'?t exist|playwright install/i.test(message);
}

function publicNavigationMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const firstLine = raw.split("\n")[0] ?? "";
  const cleaned = firstLine
    .replace(/[A-Za-z]:\\[^\s"']*/g, "")
    .replace(/\/[^\s"']*node_modules[^\s"']*/g, "")
    .replace(/\S+\.[cm]?[jt]s:\d+(:\d+)?/g, "")
    .trim();
  return cleaned === "" ? "The page could not be loaded." : `The page could not be loaded: ${cleaned.slice(0, 200)}`;
}

function codeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** For logs only. Query strings routinely carry click ids and tokens. */
function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
