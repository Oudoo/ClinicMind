#!/usr/bin/env node
// A dependency-free static file server for the click-through prototype.
//   node scripts/static-server.mjs demo 8787
// Serves the folder read-only on http://localhost:<port>/ with the right MIME
// types; no directory listings, no path escapes, nothing cached.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "demo");
const port = Number(process.argv[3] ?? 8787);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const size = statSync(file).size;
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": size, "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`prototype: http://localhost:${port}/`);
});
