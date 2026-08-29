type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): Level {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return raw in LEVEL_ORDER ? (raw as Level) : "info";
}

/**
 * Everything goes to stderr: stdout is reserved for the CLI's JSON output, so a
 * log line must never end up inside a piped response body.
 */
export class Logger {
  constructor(private readonly prefix = "analyzer") {}

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  debug(message: string): void {
    this.write("debug", message);
  }

  private write(level: Level, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${this.prefix}] ${message}\n`;
    process.stderr.write(line);
  }
}

export const logger = new Logger();
