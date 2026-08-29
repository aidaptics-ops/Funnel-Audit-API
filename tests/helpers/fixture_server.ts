import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "landing");

/** 1x1 transparent PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface FixtureRequest {
  method: string;
  path: string;
}

export interface FixtureServer {
  base: string;
  url(path: string): string;
  /** Every request the fixture received — proves the analyser never submits. */
  requests: FixtureRequest[];
  close(): Promise<void>;
}

/**
 * Serves the landing fixtures plus deliberate 404s, so link checking, broken
 * images and redirect chains have something real to observe.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    requests.push({ method: req.method || "GET", path });

    if (path === "/go") {
      res.writeHead(302, { location: "/vsl.html" });
      res.end();
      return;
    }

    if (path === "/missing-page" || path === "/img/missing-logo.png" || path === "/img/broken.png") {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Not found</h1>");
      return;
    }

    if (path.startsWith("/img/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PIXEL);
      return;
    }

    if (path.endsWith(".html") || path === "/") {
      const name = path === "/" ? "vsl.html" : path.replace(/^\//, "");
      try {
        const body = readFileSync(join(fixtureDir, name), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end("<h1>Not found</h1>");
      }
      return;
    }

    // Everything else (e.g. /about, /privacy) resolves so link checks pass.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Page</title><p>ok</p>");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    requests,
    url: (path: string) => `${base}${path.startsWith("/") ? path : `/${path}`}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
