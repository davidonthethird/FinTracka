ALTER TABLE transactions
ADD COLUMN classification_revision INTEGER NOT NULL DEFAULT 0
    CHECK(classification_revision >= 0);

CREATE TRIGGER transactions_classification_revision_update
AFTER UPDATE OF category_id, subcategory_id ON transactions
WHEN OLD.category_id IS NOT NEW.category_id
  OR OLD.subcategory_id IS NOT NEW.subcategory_id
BEGIN
    UPDATE transactions
    SET classification_revision = OLD.classification_revision + 1
    WHERE id = NEW.id;
END;
