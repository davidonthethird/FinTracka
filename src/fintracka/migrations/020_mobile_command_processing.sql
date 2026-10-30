CREATE TABLE mobile_command_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    gateway_url TEXT,
    access_client_id_ref TEXT,
    access_client_secret_ref TEXT,
    last_checked_at TEXT,
    last_error_code TEXT CHECK (
        last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64
    ),
    updated_at TEXT NOT NULL
);

INSERT INTO mobile_command_settings (id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE mobile_command_receipts (
    command_id TEXT PRIMARY KEY,
    command_type TEXT NOT NULL CHECK (length(command_type) BETWEEN 1 AND 80),
    command_version INTEGER NOT NULL CHECK (command_version > 0),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    actor_member_id TEXT NOT NULL CHECK (length(actor_member_id) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (status IN ('applied', 'conflict', 'rejected')),
    result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 512),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
    applied_revision INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 0),
    processed_at TEXT NOT NULL,
    snapshot_published_at TEXT
);

CREATE INDEX mobile_command_receipts_publication_idx
ON mobile_command_receipts(snapshot_published_at, processed_at)
WHERE status = 'applied' AND snapshot_published_at IS NULL;
