ALTER TABLE provider_connections
ADD COLUMN credential_profile TEXT NOT NULL DEFAULT 'david'
    CHECK(credential_profile IN ('david', 'ariela'));

INSERT OR IGNORE INTO app_metadata (key, value)
SELECT 'plaid.profile.david.environment', value
FROM app_metadata
WHERE key = 'plaid.environment';

INSERT OR IGNORE INTO app_metadata (key, value)
SELECT 'plaid.profile.david.sandbox.client_id_ref', value
FROM app_metadata
WHERE key = 'plaid.sandbox.client_id_ref';

INSERT OR IGNORE INTO app_metadata (key, value)
SELECT 'plaid.profile.david.sandbox.secret_ref', value
FROM app_metadata
WHERE key = 'plaid.sandbox.secret_ref';

INSERT OR IGNORE INTO app_metadata (key, value)
SELECT 'plaid.profile.david.production.client_id_ref', value
FROM app_metadata
WHERE key = 'plaid.production.client_id_ref';

INSERT OR IGNORE INTO app_metadata (key, value)
SELECT 'plaid.profile.david.production.secret_ref', value
FROM app_metadata
WHERE key = 'plaid.production.secret_ref';
