import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(root, "frontend", "dist-viewer");
const document = JSON.parse(readFileSync(join(root, "tests", "fixtures", "remote_snapshot_v1.json"), "utf8"));
const categories = [...new Map(document.transactions.filter((item: any) => item.category_id).map((item: any) => [item.category_id, {
  id: item.category_id, name: item.category, category_type: item.amount_minor > 0 ? "income" : "expense",
  reporting_behavior: item.amount_minor > 0 ? "income" : "ordinary", group_id: null, group: null, sort_order: 0,
}])).values()];
const subcategories = [...new Map(document.transactions.filter((item: any) => item.subcategory_id).map((item: any) => [item.subcategory_id, {
  id: item.subcategory_id, category_id: item.category_id, name: item.subcategory, sort_order: 0,
}])).values()];
document.schema_version = 2;
document.capabilities = { commands: { "transaction.set_classification": [1, 2] } };
document.taxonomy = { categories, subcategories };
document.transactions = document.transactions.map((item: any) => ({ ...item, classification_revision: 0 }));

type Command = Record<string, any>;
let commands: Command[] = [];
let commandSequence = 0;
let receiptHandoffReads = 0;
const receiptHandoffId = "00000000-0000-4000-8000-000000000004";
const receiptImportId = "00000000-0000-4000-8000-000000000014";
let receiptDrafts: Record<string, any>[] = [];
const port = Number(process.env.FINTRACKA_VIEWER_E2E_PORT || 8789);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/api/v1/snapshot") return json(response, 200, document);
  if (url.pathname === "/api/v1/status") return json(response, 200, { available: true, published_at: "2026-10-27T12:01:00Z", stale: false });
  if (url.pathname === "/api/v1/mobile/session") return json(response, 200, {
    member: { id: "member-fixture", display_name: "Fixture member" },
    capabilities: { "transaction.set_classification": [1, 2], "receipts.drafts": [1] },
    server_time: new Date().toISOString(),
  });
  if (url.pathname === "/api/v1/mobile/receipt-scan-sessions" && request.method === "POST") {
    await readJson(request);
    return json(response, 201, { contract: "receipt_queue_handoff/v1", shortcut_version: 4,
      comparison_enabled: true, shortcut_name: "FinTracka Receipt Scanner",
      handoff_id: receiptHandoffId, expires_at: "2026-11-18T12:30:00.000Z" });
  }
  if (url.pathname === "/api/v1/mobile/receipt-queue-handoffs" && request.method === "GET") {
    receiptHandoffReads += 1;
    const ready = receiptHandoffReads > 1;
    return json(response, 200, { handoffs: [{ id: receiptHandoffId,
      status: ready ? "ready" : "pending", created_at: "2026-11-11T12:00:00.000Z",
      expires_at: "2026-11-18T12:30:00.000Z",
      ...(ready ? { review_path: `/receipts/import/${receiptImportId}` } : {}) }] });
  }
  if (url.pathname === `/api/v1/mobile/receipt-queue-handoffs/${receiptHandoffId}`
      && request.method === "GET") {
    return json(response, 200, { handoff: { id: receiptHandoffId, status: "pending",
      created_at: "2026-11-11T12:00:00.000Z", expires_at: "2026-11-18T12:30:00.000Z" } });
  }
  if (url.pathname === `/api/v1/mobile/receipt-imports/${receiptImportId}`) {
    if (request.method === "DELETE") { response.statusCode = 204; return response.end(); }
    return json(response, 200, { import: { id: receiptImportId, shortcut_version: 1,
      pages: [{ page_index: 0, text: "SYNTHETIC MARKET\nAPPLES 4.50\nTOTAL 4.50" }],
      created_at: "2026-11-11T12:00:00.000Z", expires_at: "2026-11-18T12:30:00.000Z" } });
  }
  if (url.pathname === "/api/v1/mobile/receipts" && request.method === "GET") {
    return json(response, 200, { drafts: receiptDrafts });
  }
  if (url.pathname === "/api/v1/mobile/receipts" && request.method === "POST") {
    const body = await readJson(request);
    const draft = { ...body.draft, id: "fixture-receipt-draft", revision: 1,
      digest: "a".repeat(64), created_at: "2026-11-11", updated_at: "2026-11-11",
      retention_at: "2027-02-09" };
    receiptDrafts = [draft];
    return json(response, 201, { draft, replayed: false });
  }
  if (url.pathname === "/api/v1/mobile/commands" && request.method === "GET") return json(response, 200, { commands });
  if (url.pathname === "/api/v1/mobile/commands" && request.method === "POST") {
    const body = await readJson(request);
    const active = commands.find((item) => item.target_id === body.target_id && ["pending", "processing"].includes(item.status));
    if (active && body.replace_command_id !== active.id) return json(response, 409, { error_code: "ACTIVE_COMMAND_EXISTS" });
    if (active) active.status = "superseded";
    const timestamp = new Date().toISOString();
    const command = {
      id: `command-${++commandSequence}`, actor_member_id: "member-fixture",
      command_type: "transaction.set_classification", command_version: 2,
      target_id: body.target_id, observed_revision: body.observed_revision,
      category_id: body.category_id, subcategory_id: body.subcategory_id, scope: body.scope,
      status: "pending", supersedes_command_id: active?.id ?? null, result: null,
      error_code: null, created_at: timestamp, updated_at: timestamp,
      expires_at: "2026-11-30T12:00:00Z", finished_at: null,
    };
    commands = [command, ...commands];
    return json(response, 201, { command, replayed: false });
  }
  const cancel = url.pathname.match(/^\/api\/v1\/mobile\/commands\/([^/]+)\/cancel$/);
  if (cancel && request.method === "POST") {
    await readJson(request);
    const command = commands.find((item) => item.id === cancel[1]);
    if (!command || command.status !== "pending") return json(response, 409, { error_code: "COMMAND_NOT_CANCELLABLE" });
    command.status = "cancelled"; command.finished_at = new Date().toISOString();
    return json(response, 200, { command });
  }
  const pathname = normalize(url.pathname).replace(/^\.\.(\/|\\)/, "");
  const file = pathname === "/" ? join(dist, "index.html") : join(dist, pathname);
  try {
    const body = readFileSync(file);
    response.setHeader("Content-Type", types[extname(file) as keyof typeof types] || "application/octet-stream");
    response.end(body);
  } catch {
    response.setHeader("Content-Type", "text/html"); response.end(readFileSync(join(dist, "index.html")));
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`viewer fixture ${document.snapshot_id} on ${port}\n`));

function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status; response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
