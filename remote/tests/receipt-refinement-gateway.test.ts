import { describe, expect, it, vi } from "vitest";

import { handleReceiptRefinementMac } from "../src/receiptRefinementGateway";

const ORIGIN = "https://view.test";

describe("receipt refinement Mac gateway", () => {
  it("claims at most three jobs and rejects browser-style methods", async () => {
    const store = { claim: vi.fn(async () => [{ id: "r", input_digest: "d".repeat(64),
      claim_token: "t".repeat(43), claimed_until: "2026-11-04T12:05:00.000Z" }]) };
    const response = await handleReceiptRefinementMac(request("/claim", { limit: 99 }), store as never);
    expect(response?.status).toBe(200);
    expect(store.claim).toHaveBeenCalledWith(3);
    expect((await response?.json()) as object).toMatchObject({ refinements: [{ id: "r" }] });
    expect((await handleReceiptRefinementMac(new Request(`${ORIGIN}/api/v1/mobile/mac/receipt-refinements/claim`),
      store as never))?.status).toBe(405);
  });

  it("strictly completes or safely fails a claimed job", async () => {
    const store = {
      complete: vi.fn(async () => ({ status: "completed" })),
      fail: vi.fn(async () => undefined),
    };
    const complete = await handleReceiptRefinementMac(request("/job/complete", {
      claim_token: "t".repeat(43), input_digest: "d".repeat(64), text: "SHOP TOTAL 1.00",
      model_result: "{}",
    }), store as never);
    expect(complete?.status).toBe(200);
    expect(store.complete).toHaveBeenCalledWith("job", "t".repeat(43), "d".repeat(64),
      "SHOP TOTAL 1.00", "{}");
    const failed = await handleReceiptRefinementMac(request("/job/fail", {
      claim_token: "t".repeat(43), error_code: "MODEL_UNAVAILABLE",
    }), store as never);
    expect(failed?.status).toBe(204);
    expect(store.fail).toHaveBeenCalledWith("job", "t".repeat(43), "MODEL_UNAVAILABLE");
  });

  it("does not accept images or unknown fields", async () => {
    const store = { complete: vi.fn() };
    const response = await handleReceiptRefinementMac(request("/job/complete", {
      claim_token: "t".repeat(43), input_digest: "d".repeat(64), text: "x", model_result: "{}",
      image: "private",
    }), store as never);
    expect(response?.status).toBe(400);
    expect(store.complete).not.toHaveBeenCalled();
  });
});

function request(suffix: string, body: object): Request {
  return new Request(`${ORIGIN}/api/v1/mobile/mac/receipt-refinements${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
