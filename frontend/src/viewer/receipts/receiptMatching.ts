import type { RemoteTransaction } from "../model";
import type { ReceiptDraft } from "./types";

export interface ReceiptCandidate {
  transaction: RemoteTransaction & { split_revision: number };
  score: number;
  dayDistance: number;
}

export function receiptCandidates(draft: ReceiptDraft, transactions: RemoteTransaction[]): ReceiptCandidate[] {
  if (!draft.purchase_date) return [];
  return transactions.flatMap((transaction) => {
    if (transaction.pending || transaction.currency !== draft.currency
        || Math.abs(transaction.amount_minor) !== draft.total_minor
        || !Number.isInteger(transaction.split_revision)) return [];
    const dayDistance = Math.abs(Date.parse(`${transaction.local_date}T00:00:00Z`)
      - Date.parse(`${draft.purchase_date}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(dayDistance) || dayDistance > 7) return [];
    const merchant = `${transaction.merchant ?? ""} ${transaction.description}`.toLowerCase();
    const words = draft.merchant.toLowerCase().split(/\W+/).filter((word) => word.length >= 3);
    const merchantMatches = words.filter((word) => merchant.includes(word)).length;
    return [{ transaction: transaction as RemoteTransaction & { split_revision: number },
      dayDistance, score: 100 - dayDistance * 5 + merchantMatches * 20 }];
  }).sort((left, right) => right.score - left.score
    || left.dayDistance - right.dayDistance
    || left.transaction.id.localeCompare(right.transaction.id));
}
