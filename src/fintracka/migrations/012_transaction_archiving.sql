ALTER TABLE transactions
ADD COLUMN user_archived INTEGER NOT NULL DEFAULT 0 CHECK(user_archived IN (0, 1));

CREATE INDEX transactions_user_archived_idx ON transactions(user_archived, local_date, id);
