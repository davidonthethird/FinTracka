import {
  ReceiptShortcutCaptureSchema,
  canonicalReceiptShortcutCapture,
  compareCapture,
  type PublicReceiptImport,
  type ScanSession,
} from "./receiptShortcutModel";
import { validateReceiptInterpretation, type ReceiptValidationResult } from "./receiptInterpretation";
import {
  ReceiptBenchmarkStore,
  ReceiptBenchmarkStoreError,
  type ReceiptBenchmarkSelection,
} from "./receiptBenchmarkStore";
import type { ReceiptModelComparison } from "./receiptModelComparison";
import { ReceiptRefinementStore } from "./receiptRefinementStore";

const THIRTY_MINUTES = 30 * 60_000;
const ONE_HOUR = 60 * 60_000;
const BODY_LIMIT = 256 * 1024;

interface StoreOptions {
  hourlySessionLimit?: number;
  activeImportLimit?: number;
  refinementEnabled?: boolean;
}

interface SessionRow {
  token_digest: string;
  household_id: string;
  actor_member_id: string;
  consumed_import_id: string | null;
  idempotency_key: string | null;
  body_digest: string | null;
  expires_at: string;
}

export type ReceiptScanResult =
  | { status: "pending" }
  | { status: "ready"; importId: string };

interface ImportRow {
  id: string;
  shortcut_version: 1 | 2 | 3;
  pages_json: string;
  validation_json: string | null;
  comparison_json: string | null;
  benchmark_id: string | null;
  selection: ReceiptBenchmarkSelection | null;
  refinement_id: string | null;
  refinement_status: "pending" | "claimed" | "completed" | "failed" | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
}

export class ReceiptShortcutStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReceiptShortcutStoreError"; }
}

export class ReceiptShortcutStore {
  private readonly hourlySessionLimit: number;
  private readonly activeImportLimit: number;
  private readonly refinementEnabled: boolean;

  constructor(
    private readonly database: D1Database,
    private readonly clock: () => Date = () => new Date(),
    options: StoreOptions = {},
  ) {
    this.hourlySessionLimit = options.hourlySessionLimit ?? 10;
    this.activeImportLimit = options.activeImportLimit ?? 5;
    this.refinementEnabled = options.refinementEnabled ?? true;
  }

  async createSession(householdId: string, memberId: string): Promise<ScanSession> {
    await this.cleanup();
    await this.ensureMember(householdId, memberId);
    const nowDate = this.clock();
    const since = new Date(nowDate.getTime() - ONE_HOUR).toISOString();
    const count = await this.database.prepare(`SELECT COUNT(*) AS count FROM receipt_scan_sessions
      WHERE actor_member_id = ? AND created_at >= ?`).bind(memberId, since).first<{ count: number }>();
    if ((count?.count ?? 0) >= this.hourlySessionLimit) {
      throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_RATE_LIMITED");
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = base64Url(bytes);
    const digest = await sha256Hex(token);
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + THIRTY_MINUTES).toISOString();
    try {
      await this.database.prepare(`INSERT INTO receipt_scan_sessions
        (token_digest, household_id, actor_member_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`).bind(digest, householdId, memberId, now, expiresAt).run();
    } catch (error) {
      if (errorIncludes(error, "receipt scan session rate limited")) {
        throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_RATE_LIMITED");
      }
      throw error;
    }
    return { token, expires_at: expiresAt };
  }

  async createImport(
    token: string,
    untrustedCapture: unknown,
  ): Promise<{ import: PublicReceiptImport; replayed: boolean }> {
    const parsed = ReceiptShortcutCaptureSchema.safeParse(untrustedCapture);
    if (!parsed.success) throw new ReceiptShortcutStoreError("INVALID_RECEIPT_SHORTCUT_CAPTURE");
    const canonical = canonicalReceiptShortcutCapture(untrustedCapture);
    if (new TextEncoder().encode(canonical).byteLength > BODY_LIMIT) {
      throw new ReceiptShortcutStoreError("RECEIPT_SHORTCUT_BODY_TOO_LARGE");
    }
    const tokenDigest = await sha256Hex(token);
    const bodyDigest = await sha256Hex(canonical);
    const validation = parsed.data.shortcut_version === 2
      ? validateReceiptInterpretation(parsed.data.pages[0].text, parsed.data.model_result)
      : null;
    const comparison = parsed.data.shortcut_version === 3 ? compareCapture(parsed.data) : null;
    const session = await this.database.prepare(`SELECT token_digest, household_id, actor_member_id,
      consumed_import_id, idempotency_key, body_digest, expires_at
      FROM receipt_scan_sessions WHERE token_digest = ?`).bind(tokenDigest).first<SessionRow>();
    if (!session) throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_INVALID");
    if (session.expires_at <= this.clock().toISOString()) {
      throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_EXPIRED");
    }
    await this.cleanup();
    if (session.consumed_import_id) {
      if (session.idempotency_key !== parsed.data.idempotency_key || session.body_digest !== bodyDigest) {
        throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_CONSUMED");
      }
      await this.ensureRefinement(validation, session.consumed_import_id, session.household_id,
        session.actor_member_id, bodyDigest);
      await this.ensureBenchmark(comparison, session.consumed_import_id, session.household_id,
        session.actor_member_id);
      return { import: await this.requireImport(session.household_id, session.actor_member_id,
        session.consumed_import_id), replayed: true };
    }
    await this.ensureMember(session.household_id, session.actor_member_id);
    const active = await this.database.prepare(`SELECT COUNT(*) AS count FROM receipt_shortcut_imports
      WHERE actor_member_id = ? AND expires_at > ?`).bind(session.actor_member_id, this.clock().toISOString())
      .first<{ count: number }>();
    if ((active?.count ?? 0) >= this.activeImportLimit) {
      throw new ReceiptShortcutStoreError("TOO_MANY_RECEIPT_IMPORTS");
    }
    const id = crypto.randomUUID();
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + THIRTY_MINUTES).toISOString();
    try {
      await this.database.batch([
        this.database.prepare(`INSERT INTO receipt_shortcut_imports
          (id, session_token_digest, household_id, actor_member_id, contract_version,
           shortcut_version, pages_json, model_result, validation_json, model_runs_json,
           comparison_json, idempotency_key, body_digest, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          id, tokenDigest, session.household_id, session.actor_member_id,
          parsed.data.shortcut_version, parsed.data.shortcut_version,
          JSON.stringify(parsed.data.pages), parsed.data.shortcut_version === 2 ? parsed.data.model_result : null,
          validation ? JSON.stringify(validation) : null,
          parsed.data.shortcut_version === 3 ? JSON.stringify(parsed.data.runs) : null,
          comparison ? JSON.stringify(comparison) : null,
          parsed.data.idempotency_key, bodyDigest, now, expiresAt,
        ),
        this.database.prepare(`UPDATE receipt_scan_sessions SET consumed_import_id = ?,
          idempotency_key = ?, body_digest = ?, consumed_at = ?
          WHERE token_digest = ? AND consumed_import_id IS NULL AND expires_at > ?`).bind(
          id, parsed.data.idempotency_key, bodyDigest, now, tokenDigest, now,
        ),
      ]);
    } catch (error) {
      if (errorIncludes(error, "too many receipt imports")) {
        throw new ReceiptShortcutStoreError("TOO_MANY_RECEIPT_IMPORTS");
      }
      const raced = await this.database.prepare(`SELECT token_digest, household_id, actor_member_id,
        consumed_import_id, idempotency_key, body_digest, expires_at
        FROM receipt_scan_sessions WHERE token_digest = ?`).bind(tokenDigest).first<SessionRow>();
      if (raced?.consumed_import_id && raced.idempotency_key === parsed.data.idempotency_key
          && raced.body_digest === bodyDigest) {
        await this.ensureRefinement(validation, raced.consumed_import_id, raced.household_id,
          raced.actor_member_id, bodyDigest);
        await this.ensureBenchmark(comparison, raced.consumed_import_id, raced.household_id,
          raced.actor_member_id);
        return { import: await this.requireImport(raced.household_id, raced.actor_member_id,
          raced.consumed_import_id), replayed: true };
      }
      throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_CONSUMED");
    }
    await this.ensureRefinement(validation, id, session.household_id, session.actor_member_id, bodyDigest);
    await this.ensureBenchmark(comparison, id, session.household_id, session.actor_member_id);
    return { import: await this.requireImport(session.household_id, session.actor_member_id, id), replayed: false };
  }

  async getSessionResult(
    householdId: string,
    memberId: string,
    token: string,
  ): Promise<ReceiptScanResult> {
    const tokenDigest = await sha256Hex(token);
    const session = await this.database.prepare(`SELECT token_digest, household_id, actor_member_id,
      consumed_import_id, idempotency_key, body_digest, expires_at
      FROM receipt_scan_sessions
      WHERE token_digest = ? AND household_id = ? AND actor_member_id = ?`)
      .bind(tokenDigest, householdId, memberId).first<SessionRow>();
    if (!session) throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_INVALID");
    if (session.expires_at <= this.clock().toISOString()) {
      throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_EXPIRED");
    }
    return session.consumed_import_id
      ? { status: "ready", importId: session.consumed_import_id }
      : { status: "pending" };
  }

  async getImport(householdId: string, memberId: string, id: string): Promise<PublicReceiptImport> {
    await this.cleanup();
    return this.requireImport(householdId, memberId, id);
  }

  async deleteImport(householdId: string, memberId: string, id: string): Promise<void> {
    const result = await this.database.prepare(`DELETE FROM receipt_shortcut_imports
      WHERE id = ? AND household_id = ? AND actor_member_id = ?`).bind(id, householdId, memberId).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ReceiptShortcutStoreError("RECEIPT_IMPORT_NOT_FOUND");
    }
  }

  async retryImport(householdId: string, memberId: string, id: string): Promise<void> {
    await new ReceiptRefinementStore(this.database, this.clock)
      .retryImport(id, householdId, memberId);
  }

  async selectImport(
    householdId: string,
    memberId: string,
    id: string,
    selection: ReceiptBenchmarkSelection,
  ): Promise<PublicReceiptImport> {
    const current = await this.requireImport(householdId, memberId, id);
    if (current.shortcut_version !== 3 || !current.comparison) {
      throw new ReceiptShortcutStoreError("RECEIPT_COMPARISON_NOT_FOUND");
    }
    if (current.selection && current.selection !== selection) {
      throw new ReceiptShortcutStoreError("RECEIPT_BENCHMARK_ALREADY_SELECTED");
    }
    const validation = selection === "on_device" || selection === "private_cloud_compute"
      ? current.comparison.runs.find((run) => run.model === selection)?.validation ?? null
      : null;
    const row = await this.database.prepare(`SELECT benchmark_id FROM receipt_shortcut_imports
      WHERE id = ? AND household_id = ? AND actor_member_id = ? AND expires_at > ?`)
      .bind(id, householdId, memberId, this.clock().toISOString()).first<{ benchmark_id: string | null }>();
    if (!row?.benchmark_id) throw new ReceiptShortcutStoreError("RECEIPT_BENCHMARK_NOT_FOUND");
    try {
      await new ReceiptBenchmarkStore(this.database, this.clock)
        .select(householdId, memberId, row.benchmark_id, selection);
    } catch (error) {
      if (error instanceof ReceiptBenchmarkStoreError) {
        throw new ReceiptShortcutStoreError(error.code);
      }
      throw error;
    }
    await this.database.prepare(`UPDATE receipt_shortcut_imports
      SET selection = ?, selected_validation_json = ?
      WHERE id = ? AND household_id = ? AND actor_member_id = ? AND selection IS NULL`)
      .bind(selection, validation ? JSON.stringify(validation) : null, id, householdId, memberId).run();
    return this.requireImport(householdId, memberId, id);
  }

  private async cleanup(): Promise<void> {
    const now = this.clock();
    await this.database.batch([
      this.database.prepare("DELETE FROM receipt_shortcut_imports WHERE expires_at <= ?")
        .bind(now.toISOString()),
      this.database.prepare("DELETE FROM receipt_scan_sessions WHERE created_at < ?")
        .bind(new Date(now.getTime() - ONE_HOUR).toISOString()),
    ]);
  }

  private async ensureMember(householdId: string, memberId: string): Promise<void> {
    const row = await this.database.prepare(`SELECT member.id FROM household_members member
      JOIN households household ON household.id = member.household_id
      WHERE member.id = ? AND member.household_id = ? AND member.active = 1 AND household.active = 1`)
      .bind(memberId, householdId).first();
    if (!row) throw new ReceiptShortcutStoreError("MEMBER_NOT_AUTHORIZED");
  }

  private async ensureRefinement(validation: ReceiptValidationResult | null, importId: string,
    householdId: string, memberId: string, bodyDigest: string): Promise<void> {
    if (this.refinementEnabled && validation?.status === "needs_refinement") {
      await new ReceiptRefinementStore(this.database, this.clock)
        .createForImport(importId, householdId, memberId, bodyDigest);
    }
  }

  private async ensureBenchmark(comparison: ReceiptModelComparison | null, importId: string,
    householdId: string, memberId: string): Promise<void> {
    if (!comparison) return;
    const existing = await this.database.prepare(`SELECT benchmark_id FROM receipt_shortcut_imports
      WHERE id = ?`).bind(importId).first<{ benchmark_id: string | null }>();
    if (existing?.benchmark_id) return;
    const benchmarkId = await new ReceiptBenchmarkStore(this.database, this.clock)
      .record(householdId, memberId, comparison);
    await this.database.prepare(`UPDATE receipt_shortcut_imports SET benchmark_id = ?
      WHERE id = ? AND benchmark_id IS NULL`).bind(benchmarkId, importId).run();
  }

  private async requireImport(householdId: string, memberId: string, id: string): Promise<PublicReceiptImport> {
    const row = await this.database.prepare(`SELECT receipt_import.id, receipt_import.shortcut_version,
      receipt_import.pages_json,
      COALESCE(receipt_import.selected_validation_json, receipt_import.validation_json) AS validation_json,
      receipt_import.comparison_json, receipt_import.benchmark_id, receipt_import.selection,
      receipt_import.created_at,
      receipt_import.expires_at, refinement.id AS refinement_id, refinement.status AS refinement_status,
      refinement.error_code
      FROM receipt_shortcut_imports receipt_import
      LEFT JOIN receipt_refinements refinement ON refinement.import_id = receipt_import.id
      WHERE receipt_import.id = ? AND receipt_import.household_id = ? AND receipt_import.actor_member_id = ?
      AND receipt_import.expires_at > ?`).bind(id, householdId, memberId, this.clock().toISOString()).first<ImportRow>();
    if (!row) throw new ReceiptShortcutStoreError("RECEIPT_IMPORT_NOT_FOUND");
    return { id: row.id, shortcut_version: row.shortcut_version,
      pages: JSON.parse(row.pages_json) as PublicReceiptImport["pages"],
      validation: row.validation_json ? JSON.parse(row.validation_json) as ReceiptValidationResult : null,
      comparison: row.comparison_json ? JSON.parse(row.comparison_json) as ReceiptModelComparison : null,
      selection: row.selection,
      refinement: row.refinement_id && row.refinement_status ? { id: row.refinement_id,
        status: row.refinement_status, error_code: row.error_code } : null,
      created_at: row.created_at, expires_at: row.expires_at };
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorIncludes(error: unknown, message: string): boolean {
  return String(error).toLowerCase().includes(message);
}
