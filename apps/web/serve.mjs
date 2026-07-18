/**
 * Zero-dependency static server for the BV-SALA web prototype.
 *
 * Local preview only. This serves apps/web on localhost — it does NOT deploy
 * anything and has no connection to the official bivelio.com site or its infra.
 *
 * Usage:  node apps/web/serve.mjs   (or: pnpm web:dev)
 *
 * © 2026 BiVelio Inc. — Proprietary & confidential.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4321;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    // Prevent path traversal: resolve within `here` only.
    const filePath = normalize(join(here, pathname));
    if (!filePath.startsWith(here)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`BV-SALA web prototype → http://localhost:${PORT}`);
  console.log("(local preview only — not the official bivelio.com site)");
});
