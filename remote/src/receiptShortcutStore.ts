import {
  ReceiptShortcutCaptureSchema,
  canonicalReceiptShortcutCapture,
  type PublicReceiptImport,
  type ReceiptShortcutCapture,
  type ScanSession,
} from "./receiptShortcutModel";

const TEN_MINUTES = 10 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;
const ONE_HOUR = 60 * 60_000;
const BODY_LIMIT = 128 * 1024;

interface StoreOptions {
  hourlySessionLimit?: number;
  activeImportLimit?: number;
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

interface ImportRow {
  id: string;
  shortcut_version: 1;
  pages_json: string;
  created_at: string;
  expires_at: string;
}

export class ReceiptShortcutStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReceiptShortcutStoreError"; }
}

export class ReceiptShortcutStore {
  private readonly hourlySessionLimit: number;
  private readonly activeImportLimit: number;

  constructor(
    private readonly database: D1Database,
    private readonly clock: () => Date = () => new Date(),
    options: StoreOptions = {},
  ) {
    this.hourlySessionLimit = options.hourlySessionLimit ?? 10;
    this.activeImportLimit = options.activeImportLimit ?? 5;
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
    const expiresAt = new Date(nowDate.getTime() + TEN_MINUTES).toISOString();
    await this.database.prepare(`INSERT INTO receipt_scan_sessions
      (token_digest, household_id, actor_member_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`).bind(digest, householdId, memberId, now, expiresAt).run();
    return { token, expires_at: expiresAt };
  }

  async createImport(
    token: string,
    untrustedCapture: ReceiptShortcutCapture,
  ): Promise<{ import: PublicReceiptImport; replayed: boolean }> {
    const parsed = ReceiptShortcutCaptureSchema.safeParse(untrustedCapture);
    if (!parsed.success) throw new ReceiptShortcutStoreError("INVALID_RECEIPT_SHORTCUT_CAPTURE");
    const canonical = canonicalReceiptShortcutCapture(parsed.data);
    if (new TextEncoder().encode(canonical).byteLength > BODY_LIMIT) {
      throw new ReceiptShortcutStoreError("RECEIPT_SHORTCUT_BODY_TOO_LARGE");
    }
    await this.cleanup();
    const tokenDigest = await sha256Hex(token);
    const bodyDigest = await sha256Hex(canonical);
    const session = await this.database.prepare(`SELECT token_digest, household_id, actor_member_id,
      consumed_import_id, idempotency_key, body_digest, expires_at
      FROM receipt_scan_sessions WHERE token_digest = ?`).bind(tokenDigest).first<SessionRow>();
    if (!session) throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_INVALID");
    if (session.expires_at <= this.clock().toISOString()) {
      throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_EXPIRED");
    }
    if (session.consumed_import_id) {
      if (session.idempotency_key !== parsed.data.idempotency_key || session.body_digest !== bodyDigest) {
        throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_CONSUMED");
      }
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
           shortcut_version, pages_json, idempotency_key, body_digest, created_at, expires_at)
          VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`).bind(
          id, tokenDigest, session.household_id, session.actor_member_id,
          JSON.stringify(parsed.data.pages), parsed.data.idempotency_key, bodyDigest, now, expiresAt,
        ),
        this.database.prepare(`UPDATE receipt_scan_sessions SET consumed_import_id = ?,
          idempotency_key = ?, body_digest = ?, consumed_at = ?
          WHERE token_digest = ? AND consumed_import_id IS NULL AND expires_at > ?`).bind(
          id, parsed.data.idempotency_key, bodyDigest, now, tokenDigest, now,
        ),
      ]);
    } catch {
      const raced = await this.database.prepare(`SELECT token_digest, household_id, actor_member_id,
        consumed_import_id, idempotency_key, body_digest, expires_at
        FROM receipt_scan_sessions WHERE token_digest = ?`).bind(tokenDigest).first<SessionRow>();
      if (raced?.consumed_import_id && raced.idempotency_key === parsed.data.idempotency_key
          && raced.body_digest === bodyDigest) {
        return { import: await this.requireImport(raced.household_id, raced.actor_member_id,
          raced.consumed_import_id), replayed: true };
      }
      throw new ReceiptShortcutStoreError("RECEIPT_SCAN_SESSION_CONSUMED");
    }
    return { import: await this.requireImport(session.household_id, session.actor_member_id, id), replayed: false };
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

  private async requireImport(householdId: string, memberId: string, id: string): Promise<PublicReceiptImport> {
    const row = await this.database.prepare(`SELECT id, shortcut_version, pages_json, created_at, expires_at
      FROM receipt_shortcut_imports WHERE id = ? AND household_id = ? AND actor_member_id = ?
      AND expires_at > ?`).bind(id, householdId, memberId, this.clock().toISOString()).first<ImportRow>();
    if (!row) throw new ReceiptShortcutStoreError("RECEIPT_IMPORT_NOT_FOUND");
    return { id: row.id, shortcut_version: row.shortcut_version,
      pages: JSON.parse(row.pages_json) as PublicReceiptImport["pages"],
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
