// Serves demo/ as a stand-in host site on its own port, so the widget runs on a
// different origin from the Worker and CORS and the origin allowlist are exercised
// for real. {{BUGZAP_ORIGIN}} in any .html file is replaced with the Worker's origin.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.npm_package_config_demoPort ?? 2834);
const WORKER = `http://localhost:${process.env.npm_package_config_port ?? 2833}`;
const ROOT = join(import.meta.dirname, "..", "demo");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
  if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    let body = await readFile(file);
    if (extname(file) === ".html") body = Buffer.from(body.toString().replaceAll("{{BUGZAP_ORIGIN}}", WORKER));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, () => console.log(`[demo] host site on http://localhost:${PORT}/`));
