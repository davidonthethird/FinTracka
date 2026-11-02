PRAGMA foreign_keys = ON;

CREATE TABLE receipt_scan_sessions (
    token_digest TEXT PRIMARY KEY CHECK(length(token_digest) = 64),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    consumed_import_id TEXT CHECK(consumed_import_id IS NULL OR length(consumed_import_id) BETWEEN 1 AND 128),
    idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128),
    body_digest TEXT CHECK(body_digest IS NULL OR length(body_digest) = 64),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    CHECK(
        (consumed_import_id IS NULL AND idempotency_key IS NULL AND body_digest IS NULL AND consumed_at IS NULL)
        OR
        (consumed_import_id IS NOT NULL AND idempotency_key IS NOT NULL AND body_digest IS NOT NULL AND consumed_at IS NOT NULL)
    )
);

CREATE INDEX receipt_scan_sessions_member_idx
ON receipt_scan_sessions(actor_member_id, created_at);

CREATE INDEX receipt_scan_sessions_cleanup_idx
ON receipt_scan_sessions(created_at);

CREATE TABLE receipt_shortcut_imports (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    session_token_digest TEXT NOT NULL UNIQUE REFERENCES receipt_scan_sessions(token_digest) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    contract_version INTEGER NOT NULL CHECK(contract_version = 1),
    shortcut_version INTEGER NOT NULL CHECK(shortcut_version = 1),
    pages_json TEXT NOT NULL CHECK(json_valid(pages_json) AND length(pages_json) <= 131072),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(actor_member_id, idempotency_key)
);

CREATE INDEX receipt_shortcut_imports_member_idx
ON receipt_shortcut_imports(household_id, actor_member_id, expires_at);

CREATE INDEX receipt_shortcut_imports_cleanup_idx
ON receipt_shortcut_imports(expires_at);

CREATE TRIGGER receipt_shortcut_import_session_guard
BEFORE INSERT ON receipt_shortcut_imports
WHEN NOT EXISTS (
    SELECT 1 FROM receipt_scan_sessions session
    WHERE session.token_digest = NEW.session_token_digest
      AND session.household_id = NEW.household_id
      AND session.actor_member_id = NEW.actor_member_id
      AND session.consumed_import_id IS NULL
      AND session.expires_at > NEW.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'receipt scan session unavailable');
END;
