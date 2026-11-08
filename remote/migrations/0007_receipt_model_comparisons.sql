PRAGMA defer_foreign_keys = ON;

CREATE TABLE receipt_shortcut_imports_v3 (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    session_token_digest TEXT NOT NULL UNIQUE REFERENCES receipt_scan_sessions(token_digest) ON DELETE CASCADE,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    contract_version INTEGER NOT NULL CHECK(contract_version IN (1, 2, 3)),
    shortcut_version INTEGER NOT NULL CHECK(shortcut_version IN (1, 2, 3)),
    pages_json TEXT NOT NULL CHECK(json_valid(pages_json) AND length(pages_json) <= 131072),
    model_result TEXT CHECK(model_result IS NULL OR length(model_result) <= 100000),
    validation_json TEXT CHECK(validation_json IS NULL OR
        (json_valid(validation_json) AND length(validation_json) <= 131072)),
    model_runs_json TEXT CHECK(model_runs_json IS NULL OR
        (json_valid(model_runs_json) AND length(model_runs_json) <= 262144)),
    comparison_json TEXT CHECK(comparison_json IS NULL OR
        (json_valid(comparison_json) AND length(comparison_json) <= 262144)),
    benchmark_id TEXT CHECK(benchmark_id IS NULL OR length(benchmark_id) BETWEEN 1 AND 128),
    selection TEXT CHECK(selection IS NULL OR
        selection IN ('on_device', 'private_cloud_compute', 'tie', 'neither')),
    selected_validation_json TEXT CHECK(selected_validation_json IS NULL OR
        (json_valid(selected_validation_json) AND length(selected_validation_json) <= 131072)),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(actor_member_id, idempotency_key)
);

INSERT INTO receipt_shortcut_imports_v3
    (id, session_token_digest, household_id, actor_member_id, contract_version, shortcut_version,
     pages_json, model_result, validation_json, idempotency_key, body_digest, created_at, expires_at)
SELECT id, session_token_digest, household_id, actor_member_id, contract_version, shortcut_version,
       pages_json, model_result, validation_json, idempotency_key, body_digest, created_at, expires_at
FROM receipt_shortcut_imports;

DROP TABLE receipt_shortcut_imports;
ALTER TABLE receipt_shortcut_imports_v3 RENAME TO receipt_shortcut_imports;

CREATE INDEX receipt_shortcut_imports_member_idx
ON receipt_shortcut_imports(household_id, actor_member_id, expires_at);
CREATE INDEX receipt_shortcut_imports_cleanup_idx ON receipt_shortcut_imports(expires_at);

CREATE TRIGGER receipt_shortcut_import_session_guard BEFORE INSERT ON receipt_shortcut_imports
WHEN NOT EXISTS (
    SELECT 1 FROM receipt_scan_sessions session
    WHERE session.token_digest = NEW.session_token_digest
      AND session.household_id = NEW.household_id
      AND session.actor_member_id = NEW.actor_member_id
      AND session.consumed_import_id IS NULL
      AND session.expires_at > NEW.created_at
)
BEGIN SELECT RAISE(ABORT, 'receipt scan session unavailable'); END;

CREATE TRIGGER receipt_shortcut_import_rate_limit BEFORE INSERT ON receipt_shortcut_imports
WHEN (
    SELECT COUNT(*) FROM receipt_shortcut_imports receipt_import
    WHERE receipt_import.actor_member_id = NEW.actor_member_id
      AND receipt_import.expires_at > NEW.created_at
) >= 5
BEGIN SELECT RAISE(ABORT, 'too many receipt imports'); END;

CREATE TABLE receipt_model_benchmarks (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    actor_member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
    shortcut_version INTEGER NOT NULL CHECK(shortcut_version = 3),
    on_device_status TEXT NOT NULL CHECK(on_device_status IN
        ('completed', 'unavailable', 'rate_limited', 'failed')),
    on_device_duration_ms INTEGER NOT NULL CHECK(on_device_duration_ms BETWEEN 0 AND 3600000),
    on_device_validation_status TEXT CHECK(on_device_validation_status IS NULL OR
        on_device_validation_status IN ('accepted', 'needs_review', 'needs_refinement')),
    on_device_issue_count INTEGER NOT NULL CHECK(on_device_issue_count BETWEEN 0 AND 100),
    on_device_supported_line_count INTEGER NOT NULL CHECK(on_device_supported_line_count BETWEEN 0 AND 200),
    on_device_total_present INTEGER NOT NULL CHECK(on_device_total_present IN (0, 1)),
    on_device_arithmetic_reconciled INTEGER NOT NULL CHECK(on_device_arithmetic_reconciled IN (0, 1)),
    pcc_status TEXT NOT NULL CHECK(pcc_status IN ('completed', 'unavailable', 'rate_limited', 'failed')),
    pcc_duration_ms INTEGER NOT NULL CHECK(pcc_duration_ms BETWEEN 0 AND 3600000),
    pcc_validation_status TEXT CHECK(pcc_validation_status IS NULL OR
        pcc_validation_status IN ('accepted', 'needs_review', 'needs_refinement')),
    pcc_issue_count INTEGER NOT NULL CHECK(pcc_issue_count BETWEEN 0 AND 100),
    pcc_supported_line_count INTEGER NOT NULL CHECK(pcc_supported_line_count BETWEEN 0 AND 200),
    pcc_total_present INTEGER NOT NULL CHECK(pcc_total_present IN (0, 1)),
    pcc_arithmetic_reconciled INTEGER NOT NULL CHECK(pcc_arithmetic_reconciled IN (0, 1)),
    recommendation TEXT NOT NULL CHECK(recommendation IN
        ('on_device', 'private_cloud_compute', 'tie', 'neither')),
    material_disagreement INTEGER NOT NULL CHECK(material_disagreement IN (0, 1)),
    selection TEXT CHECK(selection IS NULL OR
        selection IN ('on_device', 'private_cloud_compute', 'tie', 'neither')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX receipt_model_benchmarks_member_idx
ON receipt_model_benchmarks(household_id, actor_member_id, created_at);
CREATE INDEX receipt_model_benchmarks_expiry_idx ON receipt_model_benchmarks(expires_at);
