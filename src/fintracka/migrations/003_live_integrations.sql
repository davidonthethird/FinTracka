ALTER TABLE provider_connections
ADD COLUMN environment TEXT CHECK(environment IN ('sandbox', 'production') OR environment IS NULL);

CREATE INDEX provider_connections_environment_idx
ON provider_connections(provider, environment, status);
