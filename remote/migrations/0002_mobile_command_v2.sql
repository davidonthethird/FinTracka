DROP TRIGGER mobile_commands_replacement_guard;
DROP INDEX mobile_commands_one_active_target_idx;
DROP INDEX mobile_commands_queue_idx;
DROP INDEX mobile_commands_expiry_idx;
DROP INDEX mobile_commands_retention_idx;
DROP INDEX command_events_command_idx;

ALTER TABLE mobile_commands RENAME TO mobile_commands_v1;
ALTER TABLE command_events RENAME TO command_events_v1;

CREATE TABLE mobile_commands (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id),
    command_type TEXT NOT NULL CHECK(command_type = 'transaction.set_classification'),
    command_version INTEGER NOT NULL CHECK(command_version IN (1, 2)),
    target_type TEXT NOT NULL CHECK(target_type = 'transaction'),
    target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
    observed_revision INTEGER NOT NULL CHECK(observed_revision >= 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json) <= 512),
    payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'processing', 'applied', 'conflict', 'rejected',
        'cancelled', 'expired', 'superseded'
    )),
    supersedes_command_id TEXT REFERENCES mobile_commands(id),
    processor_id TEXT CHECK(processor_id IS NULL OR length(processor_id) BETWEEN 1 AND 128),
    claim_token TEXT CHECK(claim_token IS NULL OR length(claim_token) BETWEEN 1 AND 128),
    claimed_at TEXT,
    lease_expires_at TEXT,
    result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 512)),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(actor_member_id, idempotency_key)
);

INSERT INTO mobile_commands SELECT * FROM mobile_commands_v1;

CREATE TABLE command_events (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    command_id TEXT NOT NULL REFERENCES mobile_commands(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('member', 'processor', 'system')),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 80),
    safe_detail_json TEXT CHECK(
        safe_detail_json IS NULL
        OR (json_valid(safe_detail_json) AND length(safe_detail_json) <= 512)
    ),
    occurred_at TEXT NOT NULL
);

INSERT INTO command_events SELECT * FROM command_events_v1;
DROP TABLE command_events_v1;
DROP TABLE mobile_commands_v1;

CREATE UNIQUE INDEX mobile_commands_one_active_target_idx
ON mobile_commands(household_id, target_type, target_id)
WHERE status IN ('pending', 'processing');

CREATE INDEX mobile_commands_queue_idx
ON mobile_commands(household_id, status, created_at, id);

CREATE INDEX mobile_commands_expiry_idx
ON mobile_commands(status, expires_at, lease_expires_at);

CREATE INDEX mobile_commands_retention_idx
ON mobile_commands(status, finished_at);

CREATE INDEX command_events_command_idx
ON command_events(command_id, occurred_at, id);

CREATE TRIGGER mobile_commands_replacement_guard
BEFORE INSERT ON mobile_commands
WHEN NEW.supersedes_command_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mobile_commands prior
    WHERE prior.id = NEW.supersedes_command_id
      AND prior.household_id = NEW.household_id
      AND prior.target_type = NEW.target_type
      AND prior.target_id = NEW.target_id
      AND prior.status = 'superseded'
      AND prior.updated_at = NEW.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'replacement target is not pending');
END;
