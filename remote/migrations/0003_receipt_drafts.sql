CREATE TABLE receipt_drafts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    creator_member_id TEXT NOT NULL REFERENCES household_members(id),
    contract_version INTEGER NOT NULL CHECK(contract_version = 1),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    status TEXT NOT NULL CHECK(status IN (
        'editing', 'waiting_for_bank', 'match_pending', 'processing',
        'matched', 'conflict', 'dismissed'
    )),
    body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(body_json) <= 262144),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    retention_at TEXT NOT NULL
);

CREATE INDEX receipt_drafts_household_idx
ON receipt_drafts(household_id, status, updated_at DESC, id);
CREATE INDEX receipt_drafts_retention_idx ON receipt_drafts(retention_at);

CREATE TABLE receipt_lines (
    draft_id TEXT NOT NULL REFERENCES receipt_drafts(id) ON DELETE CASCADE,
    line_id TEXT NOT NULL CHECK(length(line_id) BETWEEN 1 AND 128),
    line_order INTEGER NOT NULL CHECK(line_order >= 0),
    line_json TEXT NOT NULL CHECK(json_valid(line_json) AND length(line_json) <= 8192),
    PRIMARY KEY(draft_id, line_id),
    UNIQUE(draft_id, line_order)
);

CREATE TABLE receipt_revisions (
    draft_id TEXT NOT NULL REFERENCES receipt_drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    actor_member_id TEXT NOT NULL REFERENCES household_members(id),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
    body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(body_json) <= 262144),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(draft_id, revision),
    UNIQUE(actor_member_id, idempotency_key)
);

CREATE TRIGGER receipt_revision_guard
BEFORE INSERT ON receipt_revisions
WHEN NOT EXISTS (
    SELECT 1 FROM receipt_drafts draft
    WHERE draft.id = NEW.draft_id
      AND (draft.revision = NEW.revision OR draft.revision = NEW.revision - 1)
)
BEGIN
    SELECT RAISE(ABORT, 'receipt revision conflict');
END;

CREATE TABLE receipt_events (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    draft_id TEXT NOT NULL REFERENCES receipt_drafts(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('member', 'processor', 'system')),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 80),
    safe_detail_json TEXT CHECK(
        safe_detail_json IS NULL OR (json_valid(safe_detail_json) AND length(safe_detail_json) <= 512)
    ),
    occurred_at TEXT NOT NULL
);

CREATE INDEX receipt_events_draft_idx ON receipt_events(draft_id, occurred_at, id);
