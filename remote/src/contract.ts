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

const planning = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  target_total_minor: z.int(),
  actual_total_minor: z.int(),
  remaining_total_minor: z.int(),
  planned_income_total_minor: z.int(),
  surplus_shortfall_minor: z.int(),
  categories: z.array(z.object({
    category_id: z.string(),
    category: z.string(),
    historical_average_minor: z.int(),
    target_minor: z.int(),
    actual_minor: z.int(),
    remaining_minor: z.int(),
    status: z.string(),
    percent_used_basis_points: z.int().nullable(),
    subcategories: z.array(z.object({
      subcategory: z.string(), actual_minor: z.int(),
    }).strict()),
    trend: z.array(z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/), amount_minor: z.int(),
    }).strict()).max(12),
    transaction_ids: z.array(z.string()),
  }).strict()),
}).strict();

const savingsMonth = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  additions_minor: z.int(),
  spending_draw_minor: z.int(),
  closing_minor: z.int(),
}).strict();

const savings = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  owner: z.string().nullable(),
  connected_total_minor: z.int(),
  manual_savings_minor: z.int(),
  investments_minor: z.int(),
  other_assets_minor: z.int(),
  combined_total_minor: z.int(),
  contributions_minor: z.int(),
  withdrawals_minor: z.int(),
  earnings_minor: z.int(),
  accounts: z.array(z.object({
    account_id: z.string(), name: z.string(), owner: z.string(), balance_minor: z.int(), pool: z.string().nullable(),
  }).strict()),
  manual_assets: z.array(z.object({
    id: z.string(), title: z.string(), kind: z.string(), owner: z.string(),
    current_value_minor: z.int(), savings_pool: z.string().nullable(),
  }).strict()),
  activity: z.array(z.object({
    transaction_id: z.string(), local_date: date, title: z.string(), kind: z.string(),
    amount_minor: z.int(), owner: z.string(),
  }).strict()),
  goal_ledger: z.object({
    regular_minor: z.int(), retirement_minor: z.int(), combined_minor: z.int(),
    goals: z.array(z.object({
      goal_id: z.string(), name: z.string(), pool: z.string(), owner: z.string(), balance_minor: z.int(),
      monthly_target_minor: z.int(), monthly_saved_minor: z.int(), monthly_funded_basis_points: z.int().nullable(),
      overall_target_minor: z.int().nullable(), overall_remaining_minor: z.int().nullable(),
      months: z.array(savingsMonth).max(12),
    }).strict()),
  }).strict().nullable(),
}).strict();

const report = z.object({
  cash_flow: z.object({ income_minor: z.int(), spending_minor: z.int(), net_minor: z.int() }).strict(),
  spending_by_category: z.array(z.object({
    category_id: z.string().nullable(), category: z.string(), amount_minor: z.int(),
  }).strict()),
  spending_by_owner: z.array(z.object({ owner: z.string(), amount_minor: z.int() }).strict()),
  cash_flow_paths: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    nodes: z.array(z.object({
      id: z.string(), label: z.string(), kind: z.string(), amount_minor: z.int(), entry_ids: z.array(z.string()),
    }).strict()),
    links: z.array(z.object({
      source: z.int(), target: z.int(), amount_minor: z.int(), entry_ids: z.array(z.string()),
    }).strict()),
  }).strict().nullable().optional(),
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
  planning: z.record(z.string(), planning),
  savings: z.record(z.string(), savings),
  reports: z.record(z.string(), report),
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
