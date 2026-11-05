import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  TransferConnectDialog,
  transferConfirmationRequest,
  type TransferTransaction,
} from "../src/transactions/TransferConnectDialog";

const source: TransferTransaction = {
  id: "outgoing",
  local_date: "2026-10-01",
  amount_minor: -30_000,
  currency: "USD",
  description: "ZELLE TO ARIELA",
  account_name: "David Checking",
};

const matches: TransferTransaction[] = [
  {
    id: "incoming-near",
    local_date: "2026-10-05",
    amount_minor: 30_000,
    currency: "USD",
    description: "ZELLE FROM DAVID",
    merchant: "Ariela",
    account_name: "Ariela Checking",
    account_mask: "1234",
  },
  {
    id: "incoming-far",
    local_date: "2026-10-20",
    amount_minor: 30_000,
    currency: "USD",
    description: "TRANSFER CREDIT",
    account_name: "Joint Savings",
  },
];

describe("manual transfer connection", () => {
  it("renders exact options with account details and the selected confirmation", () => {
    const html = renderToStaticMarkup(
      <TransferConnectDialog
        source={source}
        matches={matches}
        selectedId="incoming-near"
        loading={false}
        error=""
        onSelect={vi.fn()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain("Connect transfer");
    expect(html).toContain("ZELLE TO ARIELA");
    expect(html).toContain("Ariela Checking •••• 1234");
    expect(html).toContain("Joint Savings");
    expect(html).toContain("$300.00");
    expect(html).toMatch(/<input[^>]+checked=""[^>]+value="incoming-near"/);
    expect(html).toContain("Confirm transfer");
  });

  it("renders loading, empty, and error states without unsafe confirmation", () => {
    const render = (props: Partial<Parameters<typeof TransferConnectDialog>[0]>) =>
      renderToStaticMarkup(
        <TransferConnectDialog
          source={source}
          matches={[]}
          loading={false}
          error=""
          onSelect={vi.fn()}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
          {...props}
        />,
      );

    expect(render({ loading: true, matches: undefined })).toContain("Finding exact matches");
    expect(render({})).toContain("No exact opposite transaction is available yet");
    expect(render({ error: "Unable to load matches" })).toContain("Unable to load matches");
    expect(render({})).toContain("disabled=\"\"");
  });

  it("builds the existing confirmation request with both selected transaction ids", () => {
    expect(transferConfirmationRequest("outgoing", "incoming-near")).toEqual({
      path: "/transfers/outgoing/confirm",
      init: {
        method: "POST",
        body: JSON.stringify({
          transaction_a: "outgoing",
          transaction_b: "incoming-near",
        }),
      },
    });
  });
});
