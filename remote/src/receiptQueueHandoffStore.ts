import { canonicalReceiptShortcutCapture } from "./receiptShortcutModel";
import {
  ReceiptShortcutStore,
  ReceiptShortcutStoreError,
  receiptSessionTokenDigest,
} from "./receiptShortcutStore";

const SEVEN_DAYS = 7 * 24 * 60 * 60_000;

export type ReceiptQueueHandoffStatus = "pending" | "processing" | "completed" | "failed";

export interface ReceiptQueueHandoff {
  id: string;
  status: ReceiptQueueHandoffStatus;
  importId: string | null;
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
    return { id, status: "pending", importId: null, errorCode: null, createdAt, expiresAt };
  }

  async listForMember(householdId: string, memberId: string): Promise<ReceiptQueueHandoff[]> {
    const result = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE household_id = ? AND actor_member_id = ? AND expires_at > ?
      ORDER BY created_at DESC LIMIT 100`).bind(householdId, memberId, this.clock().toISOString())
      .all<HandoffRow>();
    return result.results.map(publicHandoff);
  }

  async get(householdId: string, memberId: string, id: string): Promise<ReceiptQueueHandoff> {
    const row = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, error_code, created_at, expires_at
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

  async complete(id: string, untrustedCapture: unknown) {
    const row = await this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE id = ?`).bind(id).first<HandoffRow>();
    if (!row) throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_NOT_FOUND");
    if (row.expires_at <= this.clock().toISOString()) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_EXPIRED");
    }
    const bodyDigest = await sha256Hex(canonicalReceiptShortcutCapture(untrustedCapture));
    if (row.body_digest && row.body_digest !== bodyDigest) {
      throw new ReceiptQueueHandoffStoreError("RECEIPT_QUEUE_HANDOFF_CHANGED");
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
    return result;
  }

  private async loadActiveIds(limit: number): Promise<Set<string>> {
    const result = await this.database.prepare(`SELECT id FROM receipt_queue_handoffs
      WHERE status IN ('pending', 'processing') AND expires_at > ? ORDER BY created_at LIMIT ?`)
      .bind(this.clock().toISOString(), limit).all<{ id: string }>();
    return new Set(result.results.map((row) => row.id));
  }

  private async findBySession(digest: string): Promise<HandoffRow | null> {
    return this.database.prepare(`SELECT id, session_token_digest, household_id,
      actor_member_id, status, body_digest, import_id, error_code, created_at, expires_at
      FROM receipt_queue_handoffs WHERE session_token_digest = ?`).bind(digest).first<HandoffRow>();
  }
}

function publicHandoff(row: HandoffRow): ReceiptQueueHandoff {
  return { id: row.id, status: row.status, importId: row.import_id, errorCode: row.error_code,
    createdAt: row.created_at, expiresAt: row.expires_at };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
