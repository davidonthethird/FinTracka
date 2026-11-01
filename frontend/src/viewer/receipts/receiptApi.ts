import { mobileJson } from "../api";
import type { ReceiptDraft, ReceiptDraftV1 } from "./types";

export async function listReceipts(): Promise<ReceiptDraft[]> {
  return (await mobileJson<{ drafts: ReceiptDraft[] }>("/api/v1/mobile/receipts")).drafts;
}

export async function getReceipt(id: string): Promise<ReceiptDraft> {
  return (await mobileJson<{ draft: ReceiptDraft }>(`/api/v1/mobile/receipts/${encodeURIComponent(id)}`)).draft;
}

export async function createReceipt(draft: ReceiptDraftV1, idempotencyKey: string = crypto.randomUUID()): Promise<ReceiptDraft> {
  return (await mobileJson<{ draft: ReceiptDraft }>("/api/v1/mobile/receipts", {
    method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey, draft }),
  })).draft;
}

export async function replaceReceipt(
  id: string, expectedRevision: number, draft: ReceiptDraftV1,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<ReceiptDraft> {
  return (await mobileJson<{ draft: ReceiptDraft }>(`/api/v1/mobile/receipts/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify({ expected_revision: expectedRevision,
      idempotency_key: idempotencyKey, draft }),
  })).draft;
}

export async function dismissReceipt(id: string, expectedRevision: number): Promise<ReceiptDraft> {
  return (await mobileJson<{ draft: ReceiptDraft }>(
    `/api/v1/mobile/receipts/${encodeURIComponent(id)}/dismiss`,
    { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) },
  )).draft;
}

export async function matchReceipt(
  id: string, expectedRevision: number, targetId: string, observedSplitRevision: number,
  idempotencyKey: string = crypto.randomUUID(), replaceCommandId: string | null = null,
): Promise<ReceiptDraft> {
  return (await mobileJson<{ draft: ReceiptDraft }>(
    `/api/v1/mobile/receipts/${encodeURIComponent(id)}/match`,
    { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision,
      target_id: targetId, observed_split_revision: observedSplitRevision,
      idempotency_key: idempotencyKey, replace_command_id: replaceCommandId }) },
  )).draft;
}
