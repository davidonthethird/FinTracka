import { canonicalReceiptShortcutCapture } from "./receiptShortcutModel";
import {
  ReceiptShortcutStore,
  ReceiptShortcutStoreError,
  receiptSessionTokenDigest,
} from "./receiptShortcutStore";

const SEVEN_DAYS = 7 * 24 * 60 * 60_000;

export type ReceiptQueueHandoffStatus = "pending" | "reviewable" | "processing" | "completed" | "failed";
export const RECEIPT_QUEUE_FAILURE_CODES = [
  "INVALID_PACKAGE", "UNRECONCILED", "MODEL_UNAVAILABLE", "VISION_FAILED", "PACKAGE_NOT_FOUND",
  "CAPTURE_MISMATCH",
] as const;
export type ReceiptQueueFailureCode = typeof RECEIPT_QUEUE_FAILURE_CODES[number];

export interface ReceiptQueueHandoff {
  id: string;
  status: ReceiptQueueHandoffStatus;
  importId: string | null;
  draftId: string | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
}

interface HandoffRow {
  id: string;
  session_token_digest: string;
  household_id: string;
  actor_member_id: string;
  status: ReceiptQueueHandoffStatus;
  body_digest: string | null;
  import_id: string | null;
  draft_id: string | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
}

export class ReceiptQueueHandoffStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReceiptQueueHandoffStoreError"; }
}

export class ReceiptQueueHandoffStore {
  constructor(
    private readonly database: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(householdId: string, memberId: string, sessionToken: string): Promise<ReceiptQueueHandoff> {
    const digest = await receiptSessionTokenDigest(sessionToken);
    const now = this.clock();
    const session = await this.database.prepare(`SELECT token_digest FROM receipt_scan_sessions
      WHERE token_digest = ? AND household_id = ? AND actor_member_id = ? AND expires_at > ?`)
      .bind(digest, householdId, memberId, now.toISOString()).first();
    if (!session) throw new ReceiptQueueHandoffStoreError("RECEIPT_SCAN_SESSION_INVALID");
    const existing = await this.findBySession(digest);
    if (existing) return publicHandoff(existing);
    const id = crypto.randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SEVEN_DAYS).toISOString();
    try {
      await this.database.prepare(`INSERT INTO receipt_queue_handoffs
        (id, session_token_digest, household_id, actor_member_id, status,
         created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).bind(
          id, digest, householdId, memberId, createdAt, createdAt, expiresAt,
        ).run();
    } catch {
      const raced = await this.findBySession(digest);
      if (raced) return publicHandoff(raced);
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CREATE_FAILED");
    }
    return { id, status: "pending", importId: null, draftId: null, errorCode: null, createdAt, expiresAt };
  }

  async listForMember(householdId: string, memberId: string): Promise<ReceiptQueueHandoff[]> {
    const result = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, draft_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE household_id = ? AND actor_member_id = ? AND expires_at > ?
      ORDER BY created_at DESC LIMIT 100`).bind(householdId, memberId, this.clock().toISOString())
      .all<HandoffRow>();
    return result.results.map(publicHandoff);
  }

  async get(householdId: string, memberId: string, id: string): Promise<ReceiptQueueHandoff> {
    const row = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, draft_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE id = ? AND household_id = ? AND actor_member_id = ?`)
      .bind(id, householdId, memberId).first<HandoffRow>();
    if (!row) throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_NOT_FOUND");
    if (row.expires_at <= this.clock().toISOString()) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_EXPIRED");
    }
    return publicHandoff(row);
  }

  listActiveIds(limit = 100): Promise<Set<string>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("receipt queue handoff limit must be between 1 and 100");
    }
    return this.loadActiveIds(limit);
  }

  async start(id: string): Promise<ReceiptQueueHandoff> {
    const row = await this.load(id);
    this.requireActive(row);
    if (row.status === "pending" || row.status === "reviewable") {
      await this.database.prepare(`UPDATE receipt_queue_handoffs SET status = 'processing',
        error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'reviewable')`)
        .bind(this.clock().toISOString(), id).run();
      row.status = "processing";
      row.error_code = null;
    }
    return publicHandoff(row);
  }

  async fail(id: string, errorCode: ReceiptQueueFailureCode): Promise<ReceiptQueueHandoff> {
    const row = await this.load(id);
    this.requireActive(row);
    if (row.status === "completed") {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_FINISHED");
    }
    if (row.status === "failed") {
      if (row.error_code !== errorCode) {
        throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
      }
      return publicHandoff(row);
    }
    await this.database.prepare(`UPDATE receipt_queue_handoffs SET status = 'failed',
      error_code = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'reviewable', 'processing')`)
      .bind(errorCode, this.clock().toISOString(), id).run();
    row.status = "failed";
    row.error_code = errorCode;
    return publicHandoff(row);
  }

  async complete(id: string, untrustedCapture: unknown) {
    const row = await this.load(id);
    this.requireActive(row);
    if (row.status === "failed") {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_FINISHED");
    }
    const bodyDigest = await sha256Hex(canonicalReceiptShortcutCapture(untrustedCapture));
    if (row.body_digest && row.body_digest !== bodyDigest) {
      if (row.status === "completed") {
        throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
      }
      await this.database.prepare(`UPDATE receipt_queue_handoffs SET status = 'failed',
        error_code = 'CAPTURE_MISMATCH', updated_at = ? WHERE id = ?`)
        .bind(this.clock().toISOString(), id).run();
      throw new ReceiptQueueHandoffStoreError("CAPTURE_MISMATCH");
    }
    if (row.body_digest) {
      const replayed = row.status === "completed";
      if (!replayed) {
        await this.database.prepare(`UPDATE receipt_queue_handoffs SET status = 'completed',
          error_code = NULL, updated_at = ? WHERE id = ? AND body_digest = ?`)
          .bind(this.clock().toISOString(), id, bodyDigest).run();
      }
      return { kind: "verified" as const, replayed, importId: row.import_id,
        draftId: row.draft_id };
    }
    let result;
    try {
      result = await new ReceiptShortcutStore(this.database, this.clock)
        .createQueuedImport(row.session_token_digest, untrustedCapture);
    } catch (error) {
      if (error instanceof ReceiptShortcutStoreError && error.code === "RECEIPT_SCAN_SESSION_CONSUMED") {
        throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
      }
      throw error;
    }
    const now = this.clock().toISOString();
    await this.database.prepare(`UPDATE receipt_queue_handoffs SET status = 'completed',
      body_digest = ?, import_id = ?, error_code = NULL, updated_at = ?
      WHERE id = ? AND (body_digest IS NULL OR body_digest = ?)`)
      .bind(bodyDigest, result.import.id, now, id, bodyDigest).run();
    return { kind: "import" as const, ...result };
  }

  async markReviewableBySession(
    sessionTokenDigest: string,
    importId: string,
    bodyDigest: string,
  ): Promise<ReceiptQueueHandoff> {
    const row = await this.findBySession(sessionTokenDigest);
    if (!row) throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_NOT_FOUND");
    this.requireActive(row);
    if (row.status === "failed" || (row.import_id && row.import_id !== importId)
        || (row.body_digest && row.body_digest !== bodyDigest)) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
    }
    if (!/^[a-f0-9]{64}$/.test(bodyDigest)) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
    }
    if (row.status === "pending" || row.status === "processing") {
      const result = await this.database.prepare(`UPDATE receipt_queue_handoffs
        SET status = 'reviewable', body_digest = ?, import_id = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'processing') AND import_id IS NULL AND body_digest IS NULL`)
        .bind(bodyDigest, importId, this.clock().toISOString(), row.id).run();
      if ((result.meta.changes ?? 0) !== 1) {
        const raced = await this.findBySession(sessionTokenDigest);
        if (!raced || raced.import_id !== importId || raced.body_digest !== bodyDigest) {
          throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
        }
        return publicHandoff(raced);
      }
      row.status = "reviewable";
      row.body_digest = bodyDigest;
      row.import_id = importId;
      row.error_code = null;
    }
    return publicHandoff(row);
  }

  async linkDraft(
    householdId: string,
    memberId: string,
    importId: string,
    draftId: string,
  ): Promise<ReceiptQueueHandoff> {
    const row = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, draft_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE import_id = ? AND household_id = ? AND actor_member_id = ?`)
      .bind(importId, householdId, memberId).first<HandoffRow>();
    if (!row) throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_NOT_FOUND");
    this.requireActive(row);
    const draft = await this.database.prepare(`SELECT id FROM receipt_drafts
      WHERE id = ? AND household_id = ? AND creator_member_id = ?`)
      .bind(draftId, householdId, memberId).first();
    if (!draft) throw new ReceiptQueueHandoffStoreError("RECEIPT_DRAFT_NOT_FOUND");
    if (row.draft_id && row.draft_id !== draftId) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
    }
    if (!row.draft_id) {
      const result = await this.database.prepare(`UPDATE receipt_queue_handoffs SET draft_id = ?, updated_at = ?
        WHERE id = ? AND draft_id IS NULL`).bind(draftId, this.clock().toISOString(), row.id).run();
      if ((result.meta.changes ?? 0) !== 1) {
        const raced = await this.load(row.id);
        if (raced.draft_id !== draftId) {
          throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
        }
        return publicHandoff(raced);
      }
      row.draft_id = draftId;
    }
    return publicHandoff(row);
  }

  private async loadActiveIds(limit: number): Promise<Set<string>> {
    const result = await this.database.prepare(`SELECT id FROM receipt_queue_handoffs
      WHERE status IN ('pending', 'reviewable', 'processing') AND expires_at > ? ORDER BY created_at LIMIT ?`)
      .bind(this.clock().toISOString(), limit).all<{ id: string }>();
    return new Set(result.results.map((row) => row.id));
  }

  private async findBySession(digest: string): Promise<HandoffRow | null> {
    return this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, draft_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE session_token_digest = ?`).bind(digest).first<HandoffRow>();
  }

  private async load(id: string): Promise<HandoffRow> {
    const row = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, draft_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE id = ?`).bind(id).first<HandoffRow>();
    if (!row) throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_NOT_FOUND");
    return row;
  }

  private requireActive(row: HandoffRow): void {
    if (row.expires_at <= this.clock().toISOString()) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_EXPIRED");
    }
  }
}

function publicHandoff(row: HandoffRow): ReceiptQueueHandoff {
  return { id: row.id, status: row.status, importId: row.import_id, draftId: row.draft_id,
    errorCode: row.error_code,
    createdAt: row.created_at, expiresAt: row.expires_at };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
