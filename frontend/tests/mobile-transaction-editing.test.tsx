import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/remote_snapshot_v2.json";

import {
  activeCommandForTransaction,
  proposedClassification,
  statusLabel,
  type MobileCommand,
} from "../src/viewer/mobileCommands";
import { TransactionClassificationEditor } from "../src/viewer/TransactionClassificationEditor";
import { parseSnapshot } from "../src/viewer/model";

const snapshot = parseSnapshot(fixture);
const transaction = snapshot.transactions[0];

function command(overrides: Partial<MobileCommand> = {}): MobileCommand {
  return {
    id: "command-1",
    actor_member_id: "member-1",
    command_type: "transaction.set_classification",
    command_version: 1,
    target_id: transaction.id,
    observed_revision: transaction.classification_revision ?? 0,
    category_id: snapshot.schema_version === 2 ? snapshot.taxonomy.categories[0].id : null,
    subcategory_id: null,
    status: "pending",
    supersedes_command_id: null,
    result: null,
    error_code: null,
    created_at: "2026-10-30T12:00:00Z",
    updated_at: "2026-10-30T12:00:00Z",
    expires_at: "2026-11-29T12:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

describe("mobile transaction classification editing", () => {
  it("chooses only the newest active command and keeps proposed values separate", () => {
    const older = command();
    const processing = command({
      id: "command-2", status: "processing", created_at: "2026-10-30T12:01:00Z",
      category_id: snapshot.schema_version === 2
        ? snapshot.taxonomy.categories.find((item) => item.id !== transaction.category_id)?.id ?? null
        : null,
    });
    const applied = command({ id: "command-3", status: "applied", created_at: "2026-10-30T12:02:00Z" });
    expect(activeCommandForTransaction([older, processing, applied], transaction.id)?.id).toBe("command-2");
    expect(proposedClassification(processing, snapshot.schema_version === 2 ? snapshot.taxonomy : null)).toMatchObject({ pending: true });
    expect(transaction.category).not.toBe(proposedClassification(processing, snapshot.schema_version === 2 ? snapshot.taxonomy : null).category);
  });

  it("uses clear, non-color-only status language", () => {
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("processing")).toBe("Applying");
    expect(statusLabel("conflict")).toBe("Needs review");
    expect(statusLabel("superseded")).toBe("Replaced");
  });

  it("renders committed and proposed classifications separately with replace/cancel controls", () => {
    if (snapshot.schema_version !== 2) throw new Error("v2 fixture required");
    const html = renderToStaticMarkup(<TransactionClassificationEditor
      transaction={transaction}
      taxonomy={snapshot.taxonomy}
      command={command()}
      onSave={async () => undefined}
      onCancel={async () => undefined}
    />);
    expect(html).toContain("Committed classification");
    expect(html).toContain("Proposed classification");
    expect(html).toContain("Replace proposal");
    expect(html).toContain("Cancel proposal");
  });

  it("locks processing commands and supports conflict review without force overwrite", () => {
    if (snapshot.schema_version !== 2) throw new Error("v2 fixture required");
    const processing = renderToStaticMarkup(<TransactionClassificationEditor
      transaction={transaction}
      taxonomy={snapshot.taxonomy}
      command={command({ status: "processing" })}
      onSave={async () => undefined}
      onCancel={async () => undefined}
    />);
    expect(processing).toContain("Applying on your Mac");
    expect(processing).not.toContain("Cancel proposal");
    const conflict = renderToStaticMarkup(<TransactionClassificationEditor
      transaction={transaction}
      taxonomy={snapshot.taxonomy}
      command={command({ status: "conflict", result: {
        status: "conflict", category_id: transaction.category_id,
        subcategory_id: transaction.subcategory_id,
        classification_revision: (transaction.classification_revision ?? 0) + 1,
      } })}
      onSave={async () => undefined}
      onCancel={async () => undefined}
    />);
    expect(conflict).toContain("Needs review");
    expect(conflict).toContain("Review and resubmit");
  });
});
