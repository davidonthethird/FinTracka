import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(root, "frontend", "dist-viewer");
const snapshot = readFileSync(join(root, "tests", "fixtures", "remote_snapshot_v1.json"));
const document = JSON.parse(snapshot.toString());
const port = Number(process.env.FINTRACKA_VIEWER_E2E_PORT || 8789);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/api/v1/snapshot") {
    response.setHeader("Content-Type", "application/json"); response.end(snapshot); return;
  }
  if (request.url === "/api/v1/status") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ available: true, published_at: "2026-10-27T12:01:00Z", stale: false })); return;
  }
  const pathname = normalize(new URL(request.url || "/", "http://localhost").pathname).replace(/^\.\.(\/|\\)/, "");
  let file = pathname === "/" ? join(dist, "index.html") : join(dist, pathname);
  try {
    const body = readFileSync(file);
    response.setHeader("Content-Type", types[extname(file) as keyof typeof types] || "application/octet-stream");
    response.end(body);
  } catch {
    response.setHeader("Content-Type", "text/html"); response.end(readFileSync(join(dist, "index.html")));
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`viewer fixture ${document.snapshot_id} on ${port}\n`));
