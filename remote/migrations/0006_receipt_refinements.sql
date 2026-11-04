PRAGMA defer_foreign_keys = ON;

CREATE TABLE receipt_shortcut_imports_v2 (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    session_token_digest TEXT NOT NULL UNIQUE REFERENCES receipt_scan_sessions(token_digest) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    contract_version INTEGER NOT NULL CHECK(contract_version IN (1, 2)),
    shortcut_version INTEGER NOT NULL CHECK(shortcut_version IN (1, 2)),
    pages_json TEXT NOT NULL CHECK(json_valid(pages_json) AND length(pages_json) <= 131072),
    model_result TEXT CHECK(model_result IS NULL OR length(model_result) <= 100000),
    validation_json TEXT CHECK(validation_json IS NULL OR (json_valid(validation_json) AND length(validation_json) <= 131072)),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(actor_member_id, idempotency_key)
);

INSERT INTO receipt_shortcut_imports_v2
    (id, session_token_digest, household_id, actor_member_id, contract_version, shortcut_version,
     pages_json, idempotency_key, body_digest, created_at, expires_at)
SELECT id, session_token_digest, household_id, actor_member_id, contract_version, shortcut_version,
       pages_json, idempotency_key, body_digest, created_at, expires_at
FROM receipt_shortcut_imports;

DROP TABLE receipt_shortcut_imports;
ALTER TABLE receipt_shortcut_imports_v2 RENAME TO receipt_shortcut_imports;

CREATE INDEX receipt_shortcut_imports_member_idx
ON receipt_shortcut_imports(household_id, actor_member_id, expires_at);
CREATE INDEX receipt_shortcut_imports_cleanup_idx ON receipt_shortcut_imports(expires_at);

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

CREATE TRIGGER receipt_shortcut_import_rate_limit
BEFORE INSERT ON receipt_shortcut_imports
WHEN (
    SELECT COUNT(*) FROM receipt_shortcut_imports receipt_import
    WHERE receipt_import.actor_member_id = NEW.actor_member_id
      AND receipt_import.expires_at > NEW.created_at
) >= 5
BEGIN
    SELECT RAISE(ABORT, 'too many receipt imports');
END;

CREATE TABLE receipt_refinements (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    import_id TEXT NOT NULL UNIQUE REFERENCES receipt_shortcut_imports(id) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed', 'failed')),
    claim_token_digest TEXT CHECK(claim_token_digest IS NULL OR length(claim_token_digest) = 64),
    claimed_until TEXT,
    result_digest TEXT CHECK(result_digest IS NULL OR length(result_digest) = 64),
    error_code TEXT CHECK(error_code IS NULL OR error_code IN
        ('MODEL_UNAVAILABLE', 'VISION_FAILED', 'INVALID_PACKAGE', 'UNRECONCILED', 'PACKAGE_NOT_FOUND')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX receipt_refinements_claim_idx ON receipt_refinements(status, claimed_until, created_at);
CREATE INDEX receipt_refinements_expiry_idx ON receipt_refinements(expires_at);
