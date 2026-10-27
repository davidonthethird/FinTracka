ALTER TABLE savings_goals ADD COLUMN overall_target_minor INTEGER
    CHECK(overall_target_minor IS NULL OR overall_target_minor > 0);

CREATE TABLE savings_goal_overflow_rules (
    source_goal_id TEXT NOT NULL REFERENCES savings_goals(id),
    destination_goal_id TEXT NOT NULL REFERENCES savings_goals(id),
    priority INTEGER NOT NULL CHECK(priority >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(source_goal_id, destination_goal_id),
    CHECK(source_goal_id != destination_goal_id)
);
CREATE INDEX savings_goal_overflow_source_idx
ON savings_goal_overflow_rules(source_goal_id, priority, destination_goal_id);
