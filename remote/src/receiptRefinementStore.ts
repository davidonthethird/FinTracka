import { validateReceiptInterpretation } from "./receiptInterpretation";

const FIVE_MINUTES = 5 * 60_000;
const SEVEN_DAYS = 7 * 24 * 60 * 60_000;
const SAFE_ERRORS = new Set(["MODEL_UNAVAILABLE", "VISION_FAILED", "INVALID_PACKAGE", "UNRECONCILED",
  "PACKAGE_NOT_FOUND"]);
const RETRYABLE_ERRORS = new Set(["MODEL_UNAVAILABLE", "VISION_FAILED", "PACKAGE_NOT_FOUND"]);

export class ReceiptRefinementStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReceiptRefinementStoreError"; }
}

export interface ReceiptRefinementJob {
  id: string;
  input_digest: string;
  claim_token: string;
  claimed_until: string;
}

interface Row {
  id: string; import_id: string; input_digest: string; status: string;
  claim_token_digest: string | null; claimed_until: string | null; result_digest: string | null;
}

export class ReceiptRefinementStore {
  constructor(private readonly database: D1Database, private readonly clock: () => Date = () => new Date()) {}

  async createForImport(importId: string, householdId: string, memberId: string, inputDigest: string) {
    if (!/^[a-f0-9]{64}$/.test(inputDigest)) throw new ReceiptRefinementStoreError("REFINEMENT_INPUT_INVALID");
    const existing = await this.database.prepare("SELECT id, expires_at FROM receipt_refinements WHERE import_id = ?")
      .bind(importId).first<{ id: string; expires_at: string }>();
    if (existing) {
      await this.extendImport(importId, existing.expires_at);
      return existing;
    }
    const now = this.clock();
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + SEVEN_DAYS).toISOString();
    await this.database.prepare(`INSERT INTO receipt_refinements
      (id, import_id, household_id, actor_member_id, input_digest, status, created_at, updated_at, expires_at)
      SELECT ?, id, household_id, actor_member_id, ?, 'pending', ?, ?, ? FROM receipt_shortcut_imports
      WHERE id = ? AND household_id = ? AND actor_member_id = ?`).bind(
      id, inputDigest, now.toISOString(), now.toISOString(), expiresAt,
      importId, householdId, memberId,
    ).run();
    const created = await this.database.prepare("SELECT id FROM receipt_refinements WHERE import_id = ?")
      .bind(importId).first<{ id: string }>();
    if (!created) throw new ReceiptRefinementStoreError("REFINEMENT_IMPORT_NOT_FOUND");
    await this.extendImport(importId, expiresAt);
    return created;
  }

  async claim(requestedLimit: number): Promise<ReceiptRefinementJob[]> {
    const limit = Math.min(3, Math.max(1, requestedLimit));
    const now = this.clock();
    await this.database.prepare(`UPDATE receipt_refinements SET status = 'pending', claim_token_digest = NULL,
      claimed_until = NULL, updated_at = ? WHERE status = 'claimed' AND claimed_until <= ? AND expires_at > ?`)
      .bind(now.toISOString(), now.toISOString(), now.toISOString()).run();
    const rows = await this.database.prepare(`SELECT id, input_digest FROM receipt_refinements
      WHERE status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT ?`)
      .bind(now.toISOString(), limit).all<{ id: string; input_digest: string }>();
    const jobs: ReceiptRefinementJob[] = [];
    for (const row of rows.results) {
      const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await sha256(token);
      const claimedUntil = new Date(now.getTime() + FIVE_MINUTES).toISOString();
      const updated = await this.database.prepare(`UPDATE receipt_refinements SET status = 'claimed',
        claim_token_digest = ?, claimed_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(digest, claimedUntil, now.toISOString(), row.id).run();
      if ((updated.meta.changes ?? 0) === 1) jobs.push({ ...row, claim_token: token, claimed_until: claimedUntil });
    }
    return jobs;
  }

  async active(): Promise<string[]> {
    const rows = await this.database.prepare(`SELECT id FROM receipt_refinements
      WHERE status IN ('pending', 'claimed') AND expires_at > ? ORDER BY created_at`)
      .bind(this.clock().toISOString()).all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  async retryImport(importId: string, householdId: string, memberId: string): Promise<void> {
    const result = await this.database.prepare(`UPDATE receipt_refinements SET status = 'pending',
      claim_token_digest = NULL, claimed_until = NULL, error_code = NULL, updated_at = ?
      WHERE import_id = ? AND household_id = ? AND actor_member_id = ? AND status = 'failed'
      AND expires_at > ?`).bind(this.clock().toISOString(), importId, householdId, memberId,
      this.clock().toISOString()).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ReceiptRefinementStoreError("REFINEMENT_NOT_RETRYABLE");
    }
  }

  async complete(id: string, claimToken: string, inputDigest: string, text: string, modelResult: string) {
    const row = await this.claimed(id, claimToken);
    if (row.input_digest !== inputDigest) throw new ReceiptRefinementStoreError("REFINEMENT_INPUT_CHANGED");
    const resultDigest = await sha256(JSON.stringify({ text, modelResult }));
    if (row.status === "completed") {
      if (row.result_digest !== resultDigest) throw new ReceiptRefinementStoreError("REFINEMENT_ALREADY_COMPLETED");
      return { status: "completed" as const };
    }
    const validation = validateReceiptInterpretation(text, modelResult);
    if (validation.status === "needs_refinement") throw new ReceiptRefinementStoreError("REFINEMENT_UNRECONCILED");
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    await this.database.batch([
      this.database.prepare(`UPDATE receipt_shortcut_imports SET pages_json = ?, model_result = ?, validation_json = ?,
        expires_at = ?
        WHERE id = ?`).bind(JSON.stringify(refinedPages(text)), modelResult,
        JSON.stringify(validation), new Date(nowDate.getTime() + 30 * 60_000).toISOString(), row.import_id),
      this.database.prepare(`UPDATE receipt_refinements SET status = 'completed', result_digest = ?,
        updated_at = ?, error_code = NULL WHERE id = ?`).bind(resultDigest, now, id),
    ]);
    return { status: "completed" as const };
  }

  async fail(id: string, claimToken: string, errorCode: string): Promise<"pending" | "failed" | "completed"> {
    if (!SAFE_ERRORS.has(errorCode)) throw new ReceiptRefinementStoreError("REFINEMENT_ERROR_INVALID");
    const row = await this.claimed(id, claimToken);
    if (row.status === "completed") return "completed";
    const status = RETRYABLE_ERRORS.has(errorCode) ? "pending" : "failed";
    await this.database.prepare(`UPDATE receipt_refinements SET status = ?, error_code = ?, updated_at = ?,
      claim_token_digest = NULL, claimed_until = NULL WHERE id = ? AND status = 'claimed'`)
      .bind(status, errorCode, this.clock().toISOString(), id).run();
    return status;
  }

  private async claimed(id: string, claimToken: string): Promise<Row> {
    const row = await this.database.prepare(`SELECT id, import_id, input_digest, status, claim_token_digest,
      claimed_until, result_digest FROM receipt_refinements WHERE id = ?`).bind(id).first<Row>();
    if (!row) throw new ReceiptRefinementStoreError("REFINEMENT_NOT_FOUND");
    if (row.claim_token_digest !== await sha256(claimToken)) {
      throw new ReceiptRefinementStoreError("REFINEMENT_CLAIM_INVALID");
    }
    if (row.status === "completed") return row;
    if (row.status !== "claimed" || row.claimed_until! <= this.clock().toISOString()) {
      throw new ReceiptRefinementStoreError("REFINEMENT_CLAIM_INVALID");
    }
    return row;
  }

  private async extendImport(importId: string, expiresAt: string): Promise<void> {
    await this.database.prepare(`UPDATE receipt_shortcut_imports SET expires_at =
      CASE WHEN expires_at < ? THEN ? ELSE expires_at END WHERE id = ?`)
      .bind(expiresAt, expiresAt, importId).run();
  }
}

function refinedPages(text: string): { page_index: number; text: string }[] {
  const marker = /^--- PAGE (\d+) ---\n/gm;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return [{ page_index: 0, text }];
  return matches.map((match, index) => ({ page_index: Number(match[1]) - 1,
    text: text.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? text.length).trim() }));
}

function base64Url(bytes: Uint8Array): string {
  let value = ""; for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
