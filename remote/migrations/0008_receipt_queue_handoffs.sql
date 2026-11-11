PRAGMA foreign_keys = ON;

CREATE TABLE receipt_queue_handoffs (
    id TEXT PRIMARY KEY CHECK(length(id) = 36),
    session_token_digest TEXT NOT NULL UNIQUE
        REFERENCES receipt_scan_sessions(token_digest) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    body_digest TEXT CHECK(body_digest IS NULL OR length(body_digest) = 64),
    import_id TEXT UNIQUE REFERENCES receipt_shortcut_imports(id) ON DELETE SET NULL,
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX receipt_queue_handoffs_member_idx
ON receipt_queue_handoffs(household_id, actor_member_id, created_at);

CREATE INDEX receipt_queue_handoffs_active_idx
ON receipt_queue_handoffs(status, expires_at);

DROP TRIGGER receipt_shortcut_import_session_guard;

CREATE TRIGGER receipt_shortcut_import_session_guard
BEFORE INSERT ON receipt_shortcut_imports
WHEN NOT EXISTS (
    SELECT 1 FROM receipt_scan_sessions session
    WHERE session.token_digest = NEW.session_token_digest
      AND session.household_id = NEW.household_id
      AND session.actor_member_id = NEW.actor_member_id
      AND session.consumed_import_id IS NULL
      AND (
          session.expires_at > NEW.created_at
          OR EXISTS (
              SELECT 1 FROM receipt_queue_handoffs handoff
              WHERE handoff.session_token_digest = session.token_digest
                AND handoff.household_id = NEW.household_id
                AND handoff.actor_member_id = NEW.actor_member_id
                AND handoff.status IN ('pending', 'processing')
                AND handoff.expires_at > NEW.created_at
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'receipt scan session unavailable');
END;
