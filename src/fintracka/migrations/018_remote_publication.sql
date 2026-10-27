CREATE TABLE remote_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    viewer_url TEXT,
    publisher_url TEXT,
    history_months INTEGER NOT NULL DEFAULT 6 CHECK (history_months BETWEEN 1 AND 6),
    interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 15 AND 1440),
    access_client_id_ref TEXT,
    access_client_secret_ref TEXT,
    next_source_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_source_sequence > 0),
    last_snapshot_id TEXT,
    last_published_at TEXT,
    last_error_code TEXT,
    updated_at TEXT NOT NULL
);

INSERT INTO remote_settings (id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE remote_publication_runs (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK (reason IN ('manual', 'startup', 'sync', 'scheduled')),
    source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
    snapshot_id TEXT,
    record_count INTEGER,
    error_code TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX remote_publication_runs_started_idx
ON remote_publication_runs(started_at DESC);

