import {
  canonicalClassificationPayload,
  CommandResultSchema,
  CreateClassificationCommandSchema,
  MobileCommandStoreError,
  sha256Hex,
  type ClaimedCommand,
  type CommandResult,
  type CreateClassificationCommand,
  type HouseholdMember,
  type PublicMobileCommand,
} from "./mobileCommandModel";

interface MemberProvisioning {
  householdId: string;
  householdName: string;
  memberId: string;
  displayName: string;
  normalizedEmail: string;
  active: boolean;
}

interface CommandRow {
  id: string;
  household_id: string;
  actor_member_id: string;
  command_type: "transaction.set_classification";
  command_version: 1;
  target_id: string;
  observed_revision: number;
  payload_json: string;
  payload_digest: string;
  idempotency_key: string;
  status: PublicMobileCommand["status"];
  supersedes_command_id: string | null;
  claim_token: string | null;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  finished_at: string | null;
}

interface ClassificationPayload {
  category_id: string | null;
  subcategory_id: string | null;
}

export class MobileCommandStore {
  constructor(
    private readonly database: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resolveMember(email: string): Promise<HouseholdMember | null> {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return this.database.prepare(`
      SELECT m.id, m.household_id, m.display_name, m.role
      FROM household_members m
      JOIN households h ON h.id = m.household_id
      WHERE m.normalized_email = ? AND m.active = 1 AND h.active = 1
    `).bind(normalized).first<HouseholdMember>();
  }

  async upsertMember(input: MemberProvisioning): Promise<void> {
    const email = normalizeEmail(input.normalizedEmail);
    if (!email || !input.householdId || !input.memberId || !input.displayName.trim()) {
      throw new MobileCommandStoreError("INVALID_MEMBER");
    }
    const now = this.clock().toISOString();
    await this.database.batch([
      this.database.prepare(`
        INSERT INTO households (id, name, active, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1, updated_at = excluded.updated_at
      `).bind(input.householdId, input.householdName.trim(), now, now),
      this.database.prepare(`
        INSERT INTO household_members
          (id, household_id, normalized_email, display_name, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'member', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          household_id = excluded.household_id,
          normalized_email = excluded.normalized_email,
          display_name = excluded.display_name,
          active = excluded.active,
          updated_at = excluded.updated_at
      `).bind(
        input.memberId,
        input.householdId,
        email,
        input.displayName.trim(),
        input.active ? 1 : 0,
        now,
        now,
      ),
    ]);
  }

  async createOrReplace(
    householdId: string,
    actorMemberId: string,
    untrustedInput: CreateClassificationCommand,
  ): Promise<{ command: PublicMobileCommand; replayed: boolean }> {
    const parsed = CreateClassificationCommandSchema.safeParse(untrustedInput);
    if (!parsed.success) throw new MobileCommandStoreError("INVALID_COMMAND");
    const input = parsed.data;
    await this.ensureActiveMember(householdId, actorMemberId);
    const payloadJson = canonicalClassificationPayload(input.category_id, input.subcategory_id);
    const payloadDigest = await sha256Hex(payloadJson);

    const replay = await this.findIdempotent(actorMemberId, input.idempotency_key);
    if (replay) {
      if (!sameCommand(replay, input, payloadDigest)) {
        throw new MobileCommandStoreError("IDEMPOTENCY_CONFLICT");
      }
      return { command: toPublicCommand(replay), replayed: true };
    }

    const active = await this.database.prepare(`
      SELECT * FROM mobile_commands
      WHERE household_id = ? AND target_type = 'transaction' AND target_id = ?
        AND status IN ('pending', 'processing')
      LIMIT 1
    `).bind(householdId, input.target_id).first<CommandRow>();
    if (active && input.replace_command_id !== active.id) {
      throw new MobileCommandStoreError("ACTIVE_COMMAND_EXISTS");
    }
    if (active?.status === "processing") {
      throw new MobileCommandStoreError("ACTIVE_COMMAND_EXISTS");
    }
    if (!active && input.replace_command_id !== null) {
      throw new MobileCommandStoreError("REPLACE_COMMAND_NOT_FOUND");
    }

    const id = crypto.randomUUID();
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + 30 * 86_400_000).toISOString();
    const insert = this.insertCommandStatement({
      id,
      householdId,
      actorMemberId,
      input,
      payloadJson,
      payloadDigest,
      now,
      expiresAt,
    });
    try {
      if (active) {
        await this.database.batch([
          this.database.prepare(`
            UPDATE mobile_commands
            SET status = 'superseded', updated_at = ?, finished_at = ?
            WHERE id = ? AND household_id = ? AND status = 'pending'
          `).bind(now, now, active.id, householdId),
          insert,
          this.eventStatement(active.id, "member", actorMemberId, "superseded", now),
          this.eventStatement(id, "member", actorMemberId, "created", now),
        ]);
      } else {
        await this.database.batch([
          insert,
          this.eventStatement(id, "member", actorMemberId, "created", now),
        ]);
      }
    } catch (error) {
      const afterRace = await this.findIdempotent(actorMemberId, input.idempotency_key);
      if (afterRace) {
        if (sameCommand(afterRace, input, payloadDigest)) {
          return { command: toPublicCommand(afterRace), replayed: true };
        }
        throw new MobileCommandStoreError("IDEMPOTENCY_CONFLICT");
      }
      const competing = await this.database.prepare(`
        SELECT id FROM mobile_commands
        WHERE household_id = ? AND target_type = 'transaction' AND target_id = ?
          AND status IN ('pending', 'processing')
      `).bind(householdId, input.target_id).first();
      if (competing) throw new MobileCommandStoreError("ACTIVE_COMMAND_EXISTS");
      throw error;
    }
    return { command: await this.requireCommand(id), replayed: false };
  }

  async replayExisting(
    householdId: string,
    actorMemberId: string,
    untrustedInput: CreateClassificationCommand,
  ): Promise<{ command: PublicMobileCommand; replayed: true } | null> {
    const parsed = CreateClassificationCommandSchema.safeParse(untrustedInput);
    if (!parsed.success) throw new MobileCommandStoreError("INVALID_COMMAND");
    await this.ensureActiveMember(householdId, actorMemberId);
    const input = parsed.data;
    const payloadDigest = await sha256Hex(
      canonicalClassificationPayload(input.category_id, input.subcategory_id),
    );
    const existing = await this.findIdempotent(actorMemberId, input.idempotency_key);
    if (!existing) return null;
    if (!sameCommand(existing, input, payloadDigest)) {
      throw new MobileCommandStoreError("IDEMPOTENCY_CONFLICT");
    }
    return { command: toPublicCommand(existing), replayed: true };
  }

  async listVisible(householdId: string, requestedLimit = 50): Promise<PublicMobileCommand[]> {
    await this.expireAndPrune();
    const limit = Math.max(1, Math.min(requestedLimit, 100));
    const result = await this.database.prepare(`
      SELECT * FROM mobile_commands
      WHERE household_id = ?
      ORDER BY CASE WHEN status IN ('pending', 'processing') THEN 0 ELSE 1 END,
               created_at DESC,
               id DESC
      LIMIT ?
    `).bind(householdId, limit).all<CommandRow>();
    return result.results.map(toPublicCommand);
  }

  async countActive(householdId: string): Promise<number> {
    const row = await this.database.prepare(`
      SELECT COUNT(*) AS count FROM mobile_commands
      WHERE household_id = ? AND status IN ('pending', 'processing')
    `).bind(householdId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async countRecentForMember(actorMemberId: string, since: string): Promise<number> {
    const row = await this.database.prepare(`
      SELECT COUNT(*) AS count FROM mobile_commands
      WHERE actor_member_id = ? AND created_at >= ?
    `).bind(actorMemberId, since).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async cancel(
    householdId: string,
    commandId: string,
    actorMemberId: string,
  ): Promise<PublicMobileCommand> {
    await this.ensureActiveMember(householdId, actorMemberId);
    const now = this.clock().toISOString();
    const results = await this.database.batch([
      this.database.prepare(`
        UPDATE mobile_commands
        SET status = 'cancelled', updated_at = ?, finished_at = ?
        WHERE id = ? AND household_id = ? AND status = 'pending'
      `).bind(now, now, commandId, householdId),
      this.database.prepare(`
        INSERT INTO command_events
          (id, command_id, actor_type, actor_id, event_type, occurred_at)
        SELECT ?, id, 'member', ?, 'cancelled', ?
        FROM mobile_commands
        WHERE id = ? AND household_id = ? AND status = 'cancelled' AND finished_at = ?
      `).bind(crypto.randomUUID(), actorMemberId, now, commandId, householdId, now),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      throw new MobileCommandStoreError("COMMAND_NOT_CANCELLABLE");
    }
    return this.requireCommand(commandId);
  }

  async claim(processorId: string, requestedLimit = 10): Promise<ClaimedCommand[]> {
    if (!processorId || requestedLimit < 1 || requestedLimit > 10) {
      throw new MobileCommandStoreError("INVALID_CLAIM");
    }
    await this.expireAndPrune();
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(nowDate.getTime() + 5 * 60_000).toISOString();
    const candidates = await this.database.prepare(`
      SELECT id FROM mobile_commands
      WHERE status = 'pending' AND expires_at > ?
      ORDER BY created_at, id
      LIMIT ?
    `).bind(now, requestedLimit).all<{ id: string }>();
    const claimed: ClaimedCommand[] = [];
    for (const candidate of candidates.results) {
      const token = crypto.randomUUID();
      const results = await this.database.batch([
        this.database.prepare(`
          UPDATE mobile_commands
          SET status = 'processing', processor_id = ?, claim_token = ?,
              claimed_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?
        `).bind(processorId, token, now, leaseExpiresAt, now, candidate.id, now),
        this.database.prepare(`
          INSERT INTO command_events
            (id, command_id, actor_type, actor_id, event_type, occurred_at)
          SELECT ?, id, 'processor', ?, 'claimed', ?
          FROM mobile_commands WHERE id = ? AND status = 'processing' AND claim_token = ?
        `).bind(crypto.randomUUID(), processorId, now, candidate.id, token),
      ]);
      if ((results[0].meta.changes ?? 0) !== 1) continue;
      const row = await this.database.prepare(
        "SELECT * FROM mobile_commands WHERE id = ? AND claim_token = ?",
      ).bind(candidate.id, token).first<CommandRow>();
      if (row) claimed.push(toClaimedCommand(row));
    }
    return claimed;
  }

  async complete(
    commandId: string,
    claimToken: string,
    untrustedResult: CommandResult,
  ): Promise<PublicMobileCommand> {
    const parsed = CommandResultSchema.safeParse(untrustedResult);
    if (!parsed.success) throw new MobileCommandStoreError("INVALID_RESULT");
    const resultJson = JSON.stringify(parsed.data);
    if (resultJson.length > 512) throw new MobileCommandStoreError("INVALID_RESULT");
    const existing = await this.commandRow(commandId);
    if (!existing) throw new MobileCommandStoreError("COMMAND_NOT_FOUND");
    if (["applied", "conflict", "rejected"].includes(existing.status)) {
      if (existing.claim_token === claimToken && existing.result_json === resultJson) {
        return toPublicCommand(existing);
      }
      throw new MobileCommandStoreError("COMPLETION_CONFLICT");
    }
    if (existing.status !== "processing" || existing.claim_token !== claimToken) {
      throw new MobileCommandStoreError("STALE_CLAIM");
    }

    const now = this.clock().toISOString();
    const errorCode = parsed.data.status === "rejected" ? parsed.data.error_code : null;
    const results = await this.database.batch([
      this.database.prepare(`
        UPDATE mobile_commands
        SET status = ?, result_json = ?, error_code = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'processing' AND claim_token = ?
      `).bind(parsed.data.status, resultJson, errorCode, now, now, commandId, claimToken),
      this.database.prepare(`
        INSERT INTO command_events
          (id, command_id, actor_type, actor_id, event_type, safe_detail_json, occurred_at)
        SELECT ?, id, 'processor', COALESCE(processor_id, 'processor'), 'completed', ?, ?
        FROM mobile_commands
        WHERE id = ? AND status = ? AND claim_token = ? AND finished_at = ?
      `).bind(
        crypto.randomUUID(),
        JSON.stringify({ status: parsed.data.status }),
        now,
        commandId,
        parsed.data.status,
        claimToken,
        now,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      const raced = await this.commandRow(commandId);
      if (raced?.claim_token === claimToken && raced.result_json === resultJson) {
        return toPublicCommand(raced);
      }
      throw new MobileCommandStoreError("STALE_CLAIM");
    }
    return this.requireCommand(commandId);
  }

  async expireAndPrune(): Promise<{ released: number; expired: number; pruned: number }> {
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    let released = 0;
    let expired = 0;

    const leases = await this.database.prepare(`
      SELECT id, processor_id FROM mobile_commands
      WHERE status = 'processing' AND lease_expires_at <= ?
    `).bind(now).all<{ id: string; processor_id: string | null }>();
    for (const item of leases.results) {
      const results = await this.database.batch([
        this.database.prepare(`
          UPDATE mobile_commands
          SET status = 'pending', processor_id = NULL, claim_token = NULL,
              claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_expires_at <= ?
        `).bind(now, item.id, now),
        this.eventForStateStatement(
          item.id, "pending", "system", "lease-reaper", "lease_expired", now,
        ),
      ]);
      released += results[0].meta.changes ?? 0;
    }

    const overdue = await this.database.prepare(`
      SELECT id FROM mobile_commands
      WHERE status = 'pending' AND expires_at <= ?
    `).bind(now).all<{ id: string }>();
    for (const item of overdue.results) {
      const results = await this.database.batch([
        this.database.prepare(`
          UPDATE mobile_commands
          SET status = 'expired', updated_at = ?, finished_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at <= ?
        `).bind(now, now, item.id, now),
        this.eventForStateStatement(
          item.id, "expired", "system", "expiry-reaper", "expired", now,
        ),
      ]);
      expired += results[0].meta.changes ?? 0;
    }

    const cutoff = new Date(nowDate.getTime() - 90 * 86_400_000).toISOString();
    const pruneCount = await this.database.prepare(`
      SELECT COUNT(*) AS count FROM mobile_commands
      WHERE status IN ('applied', 'conflict', 'rejected', 'cancelled', 'expired', 'superseded')
        AND finished_at IS NOT NULL AND finished_at <= ?
    `).bind(cutoff).first<{ count: number }>();
    await this.database.prepare(`
      DELETE FROM mobile_commands
      WHERE status IN ('applied', 'conflict', 'rejected', 'cancelled', 'expired', 'superseded')
        AND finished_at IS NOT NULL AND finished_at <= ?
    `).bind(cutoff).run();
    return { released, expired, pruned: pruneCount?.count ?? 0 };
  }

  private async requireCommand(id: string): Promise<PublicMobileCommand> {
    const row = await this.commandRow(id);
    if (!row) throw new MobileCommandStoreError("COMMAND_NOT_FOUND");
    return toPublicCommand(row);
  }

  private async ensureActiveMember(householdId: string, memberId: string): Promise<void> {
    const row = await this.database.prepare(`
      SELECT 1
      FROM household_members m
      JOIN households h ON h.id = m.household_id
      WHERE m.id = ? AND m.household_id = ? AND m.active = 1 AND h.active = 1
    `).bind(memberId, householdId).first();
    if (!row) throw new MobileCommandStoreError("MEMBER_NOT_AUTHORIZED");
  }

  private commandRow(id: string): Promise<CommandRow | null> {
    return this.database.prepare("SELECT * FROM mobile_commands WHERE id = ?")
      .bind(id).first<CommandRow>();
  }

  private findIdempotent(actorMemberId: string, key: string): Promise<CommandRow | null> {
    return this.database.prepare(`
      SELECT * FROM mobile_commands WHERE actor_member_id = ? AND idempotency_key = ?
    `).bind(actorMemberId, key).first<CommandRow>();
  }

  private insertCommandStatement(input: {
    id: string;
    householdId: string;
    actorMemberId: string;
    input: CreateClassificationCommand;
    payloadJson: string;
    payloadDigest: string;
    now: string;
    expiresAt: string;
  }): D1PreparedStatement {
    return this.database.prepare(`
      INSERT INTO mobile_commands
        (id, household_id, actor_member_id, command_type, command_version,
         target_type, target_id, observed_revision, payload_json, payload_digest,
         idempotency_key, status, supersedes_command_id, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, 'transaction.set_classification', 1, 'transaction', ?, ?, ?, ?, ?,
              'pending', ?, ?, ?, ?)
    `).bind(
      input.id,
      input.householdId,
      input.actorMemberId,
      input.input.target_id,
      input.input.observed_revision,
      input.payloadJson,
      input.payloadDigest,
      input.input.idempotency_key,
      input.input.replace_command_id,
      input.now,
      input.now,
      input.expiresAt,
    );
  }

  private eventStatement(
    commandId: string,
    actorType: "member" | "processor" | "system",
    actorId: string,
    eventType: string,
    occurredAt: string,
  ): D1PreparedStatement {
    return this.database.prepare(`
      INSERT INTO command_events
        (id, command_id, actor_type, actor_id, event_type, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), commandId, actorType, actorId, eventType, occurredAt);
  }

  private eventForStateStatement(
    commandId: string,
    status: PublicMobileCommand["status"],
    actorType: "member" | "processor" | "system",
    actorId: string,
    eventType: string,
    occurredAt: string,
  ): D1PreparedStatement {
    return this.database.prepare(`
      INSERT INTO command_events
        (id, command_id, actor_type, actor_id, event_type, occurred_at)
      SELECT ?, id, ?, ?, ?, ?
      FROM mobile_commands
      WHERE id = ? AND status = ? AND updated_at = ?
    `).bind(
      crypto.randomUUID(), actorType, actorId, eventType, occurredAt,
      commandId, status, occurredAt,
    );
  }
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") && normalized.length <= 254 ? normalized : null;
}

function sameCommand(
  row: CommandRow,
  input: CreateClassificationCommand,
  payloadDigest: string,
): boolean {
  return row.command_type === input.command_type
    && row.command_version === input.command_version
    && row.target_id === input.target_id
    && row.observed_revision === input.observed_revision
    && row.payload_digest === payloadDigest
    && row.supersedes_command_id === input.replace_command_id;
}

function parsePayload(row: CommandRow): ClassificationPayload {
  const value = JSON.parse(row.payload_json) as ClassificationPayload;
  return { category_id: value.category_id, subcategory_id: value.subcategory_id };
}

function toPublicCommand(row: CommandRow): PublicMobileCommand {
  const payload = parsePayload(row);
  return {
    id: row.id,
    actor_member_id: row.actor_member_id,
    command_type: row.command_type,
    command_version: row.command_version,
    target_id: row.target_id,
    observed_revision: row.observed_revision,
    category_id: payload.category_id,
    subcategory_id: payload.subcategory_id,
    status: row.status,
    supersedes_command_id: row.supersedes_command_id,
    result: row.result_json ? CommandResultSchema.parse(JSON.parse(row.result_json)) : null,
    error_code: row.error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    finished_at: row.finished_at,
  };
}

function toClaimedCommand(row: CommandRow): ClaimedCommand {
  if (!row.claim_token) throw new MobileCommandStoreError("STALE_CLAIM");
  const payload = parsePayload(row);
  return {
    id: row.id,
    actor_member_id: row.actor_member_id,
    command_type: row.command_type,
    command_version: row.command_version,
    target_id: row.target_id,
    observed_revision: row.observed_revision,
    category_id: payload.category_id,
    subcategory_id: payload.subcategory_id,
    payload_digest: row.payload_digest,
    claim_token: row.claim_token,
    expires_at: row.expires_at,
  };
}
