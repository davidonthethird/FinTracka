import { describe, expect, it } from "vitest";

import {
  filterTransactions,
  freshnessLabel,
  paginateTransactions,
  parseSnapshot,
  classificationTaxonomy,
  snapshotMonths,
  supportsMobileClassification,
  type RemoteTransaction,
  type RemoteSnapshot,
} from "../src/viewer/model";
import { formatMoney } from "../src/format";

const transaction: RemoteTransaction = {
  id: "t1", local_date: "2026-10-12", amount_minor: -1234, currency: "USD",
  description: "APPLE.COM BILL", merchant: "Apple", category_id: "fun", category: "Fun",
  subcategory_id: null, subcategory: null, spending_owner: "David", account_name: "Checking",
  account_type: "depository", account_subtype: "checking", account_mask: "1234",
  institution_name: "Demo Bank", pending: false, manual_cash: false,
  is_cash_withdrawal: false, updated_at: "2026-10-12T12:00:00Z",
};

const overview = {
  cash_minor: 0, card_liabilities_minor: 0, net_position_minor: 0,
  income_minor: 0, spending_minor: 0, cash_income_minor: 0,
  cash_spending_minor: 0, cash_transfer_minor: 0, opening_cash_minor: null,
  off_bank_cash_spending_minor: 0,
};

const snapshot: RemoteSnapshot = {
  schema_version: 1,
  snapshot_id: "snapshot",
  source_sequence: 1,
  captured_at: "2026-10-27T12:00:00Z",
  source_last_sync_at: "2026-10-27T11:00:00Z",
  sources: [],
  history_start: "2026-05-01",
  history_end: "2026-10-31",
  overview: { "2026-09": overview, "2026-10": overview },
  transactions: [transaction],
  planning: {}, savings: {}, reports: {},
  counts: { transactions: 1, sources: 0, aggregate_months: 12, detailed_months: 6 },
};

describe("remote viewer model", () => {
  it("accepts schema one and rejects unsupported or malformed snapshots", () => {
    expect(parseSnapshot(snapshot).snapshot_id).toBe("snapshot");
    expect(supportsMobileClassification(snapshot)).toBe(false);
    expect(classificationTaxonomy(snapshot)).toBeNull();
    expect(() => parseSnapshot({ ...snapshot, schema_version: 3 })).toThrow();
    expect(() => parseSnapshot({ ...snapshot, transactions: "private" })).toThrow();
  });

  it("accepts schema two and exposes taxonomy only with the supported capability", () => {
    const v2 = parseSnapshot({
      ...snapshot,
      schema_version: 2,
      capabilities: { commands: { "transaction.set_classification": [1] } },
      taxonomy: {
        categories: [{
          id: "fun", name: "Fun", category_type: "expense", reporting_behavior: "ordinary",
          group_id: "lifestyle", group: "Lifestyle", sort_order: 10,
        }],
        subcategories: [{ id: "games", category_id: "fun", name: "Games", sort_order: 10 }],
      },
      transactions: [{ ...transaction, classification_revision: 0 }],
    });

    expect(supportsMobileClassification(v2)).toBe(true);
    expect(classificationTaxonomy(v2)?.subcategories[0].category_id).toBe("fun");
    expect(supportsMobileClassification(parseSnapshot({
      ...v2, capabilities: { commands: {} },
    }))).toBe(false);
  });

  it("sorts available months newest first", () => {
    expect(snapshotMonths(snapshot)).toEqual(["2026-10", "2026-09"]);
  });

  it("filters by search, account, category, owner, and month", () => {
    const data = snapshot;
    expect(filterTransactions(data.transactions, { search: "apple" })).toHaveLength(1);
    expect(filterTransactions(data.transactions, { account: "Checking" })).toHaveLength(1);
    expect(filterTransactions(data.transactions, { category: "fun" })).toHaveLength(1);
    expect(filterTransactions(data.transactions, { owner: "David" })).toHaveLength(1);
    expect(filterTransactions(data.transactions, { month: "2026-10" })).toHaveLength(1);
    expect(filterTransactions(data.transactions, { search: "groceries" })).toHaveLength(0);
  });

  it("paginates at no more than fifty rows", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ ...transaction, id: `t${index}` }));
    expect(paginateTransactions(rows, 1, 500)).toHaveLength(50);
    expect(paginateTransactions(rows, 3)).toHaveLength(20);
  });

  it("formats freshness and exact integer money", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    expect(freshnessLabel("2026-10-27T11:48:00Z", now)).toBe("12 min ago");
    expect(freshnessLabel("2026-10-25T12:00:00Z", now)).toBe("2 days ago");
    expect(freshnessLabel(null, now)).toBe("Not available");
    expect(formatMoney(-1234)).toBe("-$12.34");
  });

  it("does not touch browser persistence", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("persistence used"); } });
    expect(filterTransactions(snapshot.transactions, {})).toHaveLength(1);
    expect(parseSnapshot(snapshot).source_sequence).toBe(1);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
