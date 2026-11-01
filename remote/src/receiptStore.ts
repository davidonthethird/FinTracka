import {
  CreateReceiptDraftSchema,
  ReceiptDraftV1Schema,
  ReplaceReceiptDraftSchema,
  canonicalReceiptRevision,
  receiptRevisionDigest,
  type CreateReceiptDraft,
  type ReceiptDraftV1,
  type ReplaceReceiptDraft,
} from "./receiptModel";

export interface PublicReceiptDraft extends ReceiptDraftV1 {
  id: string;
  revision: number;
  digest: string;
  created_at: string;
  updated_at: string;
  retention_at: string;
}

interface DraftRow {
  id: string;
  revision: number;
  status: ReceiptDraftV1["status"];
  body_json: string;
  body_digest: string;
  created_at: string;
  updated_at: string;
  retention_at: string;
}

interface RevisionRow {
  draft_id: string;
  revision: number;
  body_json: string;
  body_digest: string;
  created_at: string;
}

export class ReceiptStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReceiptStoreError"; }
}

export class ReceiptStore {
  private readonly activeLimit: number;
  private readonly hourlyWriteLimit: number;

  constructor(
    private readonly database: D1Database,
    private readonly clock: () => Date = () => new Date(),
    limits: { activeLimit?: number; hourlyWriteLimit?: number } = {},
  ) {
    this.activeLimit = limits.activeLimit ?? 20;
    this.hourlyWriteLimit = limits.hourlyWriteLimit ?? 30;
  }

  async create(householdId: string, memberId: string, untrusted: unknown) {
    const parsed = CreateReceiptDraftSchema.safeParse(untrusted);
    if (!parsed.success) throw new ReceiptStoreError("INVALID_RECEIPT_DRAFT");
    await this.ensureMember(householdId, memberId);
    const bodyJson = canonicalReceiptRevision(parsed.data.draft);
    const digest = await receiptRevisionDigest(parsed.data.draft);
    const replay = await this.findIdempotent(memberId, parsed.data.idempotency_key);
    if (replay) return this.replay(replay, digest);
    await this.enforceLimits(householdId, memberId);

    const id = crypto.randomUUID();
    const now = this.clock().toISOString();
    const retention = new Date(this.clock().getTime() + 90 * 86_400_000).toISOString();
    const statements = [
      this.database.prepare(`INSERT INTO receipt_drafts
        (id, household_id, creator_member_id, contract_version, revision, status, body_json,
         body_digest, created_at, updated_at, last_activity_at, retention_at)
        VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, householdId, memberId, parsed.data.draft.status, bodyJson, digest, now, now, now, retention),
      this.database.prepare(`INSERT INTO receipt_revisions
        (draft_id, revision, actor_member_id, idempotency_key, body_json, body_digest, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`)
        .bind(id, memberId, parsed.data.idempotency_key, bodyJson, digest, now),
      ...this.lineStatements(id, parsed.data.draft),
      this.eventStatement(id, "member", memberId, "created", now),
    ];
    try {
      await this.database.batch(statements);
    } catch (error) {
      const afterRace = await this.findIdempotent(memberId, parsed.data.idempotency_key);
      if (afterRace) return this.replay(afterRace, digest);
      throw error;
    }
    return { draft: await this.get(householdId, id), replayed: false };
  }

  async replace(householdId: string, memberId: string, id: string, untrusted: unknown) {
    const parsed = ReplaceReceiptDraftSchema.safeParse(untrusted);
    if (!parsed.success) throw new ReceiptStoreError("INVALID_RECEIPT_DRAFT");
    await this.ensureMember(householdId, memberId);
    const bodyJson = canonicalReceiptRevision(parsed.data.draft);
    const digest = await receiptRevisionDigest(parsed.data.draft);
    const replay = await this.findIdempotent(memberId, parsed.data.idempotency_key);
    if (replay) {
      if (replay.draft_id !== id) throw new ReceiptStoreError("RECEIPT_IDEMPOTENCY_CONFLICT");
      return this.replay(replay, digest);
    }
    await this.enforceWriteLimit(memberId);
    const current = await this.requireRow(householdId, id);
    if (current.revision !== parsed.data.expected_revision) {
      throw new ReceiptStoreError("RECEIPT_REVISION_CONFLICT");
    }
    const revision = current.revision + 1;
    const now = this.clock().toISOString();
    const retention = new Date(this.clock().getTime() + 90 * 86_400_000).toISOString();
    try {
      await this.database.batch([
        this.database.prepare(`INSERT INTO receipt_revisions
          (draft_id, revision, actor_member_id, idempotency_key, body_json, body_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, revision, memberId, parsed.data.idempotency_key, bodyJson, digest, now),
        this.database.prepare(`UPDATE receipt_drafts SET revision = ?, status = ?, body_json = ?,
          body_digest = ?, updated_at = ?, last_activity_at = ?, retention_at = ?
          WHERE id = ? AND household_id = ? AND revision = ?`)
          .bind(revision, parsed.data.draft.status, bodyJson, digest, now, now, retention,
            id, householdId, parsed.data.expected_revision),
        this.database.prepare("DELETE FROM receipt_lines WHERE draft_id = ?").bind(id),
        ...this.lineStatements(id, parsed.data.draft),
        this.eventStatement(id, "member", memberId, "updated", now),
      ]);
    } catch (error) {
      const afterRace = await this.findIdempotent(memberId, parsed.data.idempotency_key);
      if (afterRace) return this.replay(afterRace, digest);
      throw new ReceiptStoreError("RECEIPT_REVISION_CONFLICT");
    }
    return { draft: await this.get(householdId, id), replayed: false };
  }

  async list(householdId: string): Promise<PublicReceiptDraft[]> {
    await this.expireAndPrune();
    const result = await this.database.prepare(`SELECT id, revision, status, body_json, body_digest,
      created_at, updated_at, retention_at FROM receipt_drafts WHERE household_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 100`).bind(householdId).all<DraftRow>();
    return result.results.map(toPublic);
  }

  async get(householdId: string, id: string): Promise<PublicReceiptDraft> {
    return toPublic(await this.requireRow(householdId, id));
  }

  async dismiss(householdId: string, memberId: string, id: string, expectedRevision: number) {
    await this.ensureMember(householdId, memberId);
    const row = await this.requireRow(householdId, id);
    if (row.revision !== expectedRevision) throw new ReceiptStoreError("RECEIPT_REVISION_CONFLICT");
    const body = ReceiptDraftV1Schema.parse(JSON.parse(row.body_json));
    if (["matched", "processing", "match_pending"].includes(body.status)) {
      throw new ReceiptStoreError("RECEIPT_NOT_DISMISSIBLE");
    }
    const updated = { ...body, status: "dismissed" as const };
    const result = await this.replace(householdId, memberId, id, {
      expected_revision: expectedRevision,
      idempotency_key: `dismiss-${crypto.randomUUID()}`,
      draft: updated,
    });
    return result.draft;
  }

  async getImmutableRevision(householdId: string, id: string, revision: number) {
    const row = await this.database.prepare(`SELECT revision.draft_id, revision.revision,
      revision.body_json, revision.body_digest, revision.created_at
      FROM receipt_revisions revision JOIN receipt_drafts draft ON draft.id = revision.draft_id
      WHERE revision.draft_id = ? AND revision.revision = ? AND draft.household_id = ?`)
      .bind(id, revision, householdId).first<RevisionRow>();
    if (!row) throw new ReceiptStoreError("RECEIPT_REVISION_NOT_FOUND");
    return { id: row.draft_id, revision: row.revision, digest: row.body_digest,
      draft: ReceiptDraftV1Schema.parse(JSON.parse(row.body_json)), created_at: row.created_at };
  }

  async markMatchPending(
    householdId: string,
    memberId: string,
    id: string,
    expectedRevision: number,
    targetId: string,
    splitRevision: number,
    commandId: string,
  ): Promise<PublicReceiptDraft> {
    await this.ensureMember(householdId, memberId);
    const now = this.clock().toISOString();
    const result = await this.database.prepare(`UPDATE receipt_drafts
      SET status = 'match_pending', selected_transaction_id = ?, selected_split_revision = ?,
          active_command_id = ?, updated_at = ?, last_activity_at = ?
      WHERE id = ? AND household_id = ? AND revision = ?
        AND status IN ('waiting_for_bank', 'conflict')`)
      .bind(targetId, splitRevision, commandId, now, now, id, householdId, expectedRevision).run();
    if ((result.meta.changes ?? 0) !== 1) throw new ReceiptStoreError("RECEIPT_MATCH_CONFLICT");
    await this.database.prepare(`INSERT INTO receipt_events
      (id, draft_id, actor_type, actor_id, event_type, safe_detail_json, occurred_at)
      VALUES (?, ?, 'member', ?, 'match_submitted', ?, ?)`)
      .bind(crypto.randomUUID(), id, memberId,
        JSON.stringify({ transaction_id: targetId, command_id: commandId }), now).run();
    return this.get(householdId, id);
  }

  async expireAndPrune() {
    const now = this.clock().toISOString();
    const count = await this.database.prepare("SELECT COUNT(*) AS count FROM receipt_drafts WHERE retention_at <= ?")
      .bind(now).first<{ count: number }>();
    await this.database.prepare("DELETE FROM receipt_drafts WHERE retention_at <= ?").bind(now).run();
    return { pruned: count?.count ?? 0 };
  }

  private async enforceLimits(householdId: string, memberId: string) {
    await this.enforceWriteLimit(memberId);
    const row = await this.database.prepare(`SELECT COUNT(*) AS count FROM receipt_drafts
      WHERE household_id = ? AND status NOT IN ('dismissed', 'matched')`).bind(householdId)
      .first<{ count: number }>();
    if ((row?.count ?? 0) >= this.activeLimit) throw new ReceiptStoreError("TOO_MANY_ACTIVE_RECEIPTS");
  }

  private async enforceWriteLimit(memberId: string) {
    const since = new Date(this.clock().getTime() - 60 * 60_000).toISOString();
    const row = await this.database.prepare(`SELECT COUNT(*) AS count FROM receipt_revisions
      WHERE actor_member_id = ? AND created_at >= ?`).bind(memberId, since).first<{ count: number }>();
    if ((row?.count ?? 0) >= this.hourlyWriteLimit) throw new ReceiptStoreError("RECEIPT_WRITE_RATE_LIMITED");
  }

  private async ensureMember(householdId: string, memberId: string) {
    const row = await this.database.prepare(`SELECT id FROM household_members
      WHERE id = ? AND household_id = ? AND active = 1`).bind(memberId, householdId).first();
    if (!row) throw new ReceiptStoreError("MEMBER_NOT_AUTHORIZED");
  }

  private async requireRow(householdId: string, id: string): Promise<DraftRow> {
    const row = await this.database.prepare(`SELECT id, revision, status, body_json, body_digest,
      created_at, updated_at, retention_at FROM receipt_drafts WHERE household_id = ? AND id = ?`)
      .bind(householdId, id).first<DraftRow>();
    if (!row) throw new ReceiptStoreError("RECEIPT_NOT_FOUND");
    return row;
  }

  private async findIdempotent(memberId: string, key: string) {
    return this.database.prepare(`SELECT draft_id, revision, body_json, body_digest, created_at
      FROM receipt_revisions WHERE actor_member_id = ? AND idempotency_key = ?`)
      .bind(memberId, key).first<RevisionRow>();
  }

  private replay(row: RevisionRow, digest: string) {
    if (row.body_digest !== digest) throw new ReceiptStoreError("RECEIPT_IDEMPOTENCY_CONFLICT");
    const draft = ReceiptDraftV1Schema.parse(JSON.parse(row.body_json));
    return { draft: { ...draft, id: row.draft_id, revision: row.revision,
      digest: row.body_digest, created_at: row.created_at, updated_at: row.created_at,
      retention_at: "" }, replayed: true };
  }

  private lineStatements(id: string, draft: ReceiptDraftV1) {
    return draft.lines.map((line) => this.database.prepare(`INSERT INTO receipt_lines
      (draft_id, line_id, line_order, line_json) VALUES (?, ?, ?, ?)`)
      .bind(id, line.id, line.order, JSON.stringify(line)));
  }

  private eventStatement(id: string, actorType: string, actorId: string, type: string, at: string) {
    return this.database.prepare(`INSERT INTO receipt_events
      (id, draft_id, actor_type, actor_id, event_type, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, actorType, actorId, type, at);
  }
}

function toPublic(row: DraftRow): PublicReceiptDraft {
  return {
    ...ReceiptDraftV1Schema.parse(JSON.parse(row.body_json)),
    status: row.status,
    id: row.id,
    revision: row.revision,
    digest: row.body_digest,
    created_at: row.created_at,
    updated_at: row.updated_at,
    retention_at: row.retention_at,
  };
}
