import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const timestamp = z.iso.datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/);

const source = z.object({
  name: z.string(),
  status: z.string(),
  last_success_at: timestamp.nullable(),
  error_code: z.string().nullable(),
}).strict();

const overview = z.object({
  cash_minor: z.int(),
  card_liabilities_minor: z.int(),
  net_position_minor: z.int(),
  income_minor: z.int(),
  spending_minor: z.int(),
  cash_income_minor: z.int(),
  cash_spending_minor: z.int(),
  cash_transfer_minor: z.int(),
  opening_cash_minor: z.int().nullable(),
  off_bank_cash_spending_minor: z.int(),
}).strict();

const transaction = z.object({
  id: z.string(),
  local_date: date,
  amount_minor: z.int(),
  currency,
  description: z.string(),
  merchant: z.string().nullable(),
  category_id: z.string().nullable(),
  category: z.string().nullable(),
  subcategory_id: z.string().nullable(),
  subcategory: z.string().nullable(),
  spending_owner: z.string().nullable(),
  account_name: z.string(),
  account_type: z.string(),
  account_subtype: z.string().nullable(),
  account_mask: z.string().nullable(),
  institution_name: z.string().nullable(),
  pending: z.boolean(),
  manual_cash: z.boolean(),
  is_cash_withdrawal: z.boolean(),
  updated_at: timestamp,
}).strict();

const counts = z.object({
  transactions: z.int().nonnegative(),
  sources: z.int().nonnegative(),
  aggregate_months: z.int().min(1).max(12),
  detailed_months: z.int().min(1).max(6),
}).strict();

const forbiddenKeys = new Set([
  "access_token", "external_connection_id", "keychain_account", "keychain_service",
  "notes", "provider_account_id", "raw_payload", "sanitized_json",
]);

export const RemoteSnapshotV1Schema = z.object({
  schema_version: z.literal(1),
  snapshot_id: z.string().min(1),
  source_sequence: z.int().positive(),
  captured_at: timestamp,
  source_last_sync_at: timestamp.nullable(),
  sources: z.array(source),
  history_start: date,
  history_end: date,
  overview: z.record(z.string(), overview),
  transactions: z.array(transaction),
  planning: z.record(z.string(), z.unknown()),
  savings: z.record(z.string(), z.unknown()),
  reports: z.record(z.string(), z.unknown()),
  counts,
}).strict().superRefine((value, context) => scan(value, context, []));

export type RemoteSnapshotV1 = z.infer<typeof RemoteSnapshotV1Schema>;

export function parseRemoteSnapshot(value: unknown): RemoteSnapshotV1 {
  return RemoteSnapshotV1Schema.parse(value);
}

function scan(value: unknown, context: z.RefinementCtx, path: PropertyKey[]): void {
  if (typeof value === "number" && !Number.isInteger(value)) {
    context.addIssue({ code: "custom", message: "all numeric values must be integers", path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, context, [...path, index]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) {
        context.addIssue({ code: "custom", message: "forbidden private field", path: [...path, key] });
      }
      scan(item, context, [...path, key]);
    }
  }
}
