import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TransactionDetails, type Transaction } from "../src/App";

const transaction: Transaction = {
  id: "outgoing",
  account_id: "checking",
  account_name: "David Checking",
  account_type: "depository",
  provider: "plaid",
  local_date: "2026-11-05",
  amount_minor: -120_000,
  currency: "USD",
  description: "ZELLE TO ARIELA",
  pending: false,
  manual_cash: false,
  is_cash_withdrawal: false,
  archived: false,
  updated_at: "2026-11-05T12:00:00Z",
};

describe("transaction detail transfer action", () => {
  it("offers exact transfer matching from a clicked transaction", () => {
    const html = renderToStaticMarkup(
      <TransactionDetails
        transaction={transaction}
        onMatchTransfer={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain("Match transfer");
    expect(html).toContain("Find the exact +$1,200.00 transaction");
  });
});
