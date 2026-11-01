import { z } from "zod";

export const commandStatuses = [
  "pending", "processing", "applied", "conflict", "rejected",
  "cancelled", "expired", "superseded",
] as const;

export type MobileCommandStatus = typeof commandStatuses[number];

export const categorizationScopes = ["one_time", "future", "past_and_future"] as const;
export type CategorizationScope = typeof categorizationScopes[number];

const classificationCommandFields = {
  command_type: z.literal("transaction.set_classification"),
  target_id: z.string().min(1).max(128),
  observed_revision: z.int().nonnegative(),
  category_id: z.string().min(1).max(128).nullable(),
  subcategory_id: z.string().min(1).max(128).nullable(),
  idempotency_key: z.string().min(8).max(128),
  replace_command_id: z.string().min(1).max(128).nullable(),
};

export const CreateClassificationCommandSchema = z.discriminatedUnion("command_version", [
  z.object({ ...classificationCommandFields, command_version: z.literal(1) }).strict(),
  z.object({
    ...classificationCommandFields,
    command_version: z.literal(2),
    scope: z.enum(categorizationScopes),
  }).strict(),
]).superRefine((value, context) => {
  if (value.category_id === null && value.subcategory_id !== null) {
    context.addIssue({
      code: "custom",
      message: "subcategory requires a category",
      path: ["subcategory_id"],
    });
  }
});

export type CreateClassificationCommand = z.infer<typeof CreateClassificationCommandSchema>;

const receiptSplitCommandFields = {
  command_type: z.literal("transaction.apply_receipt_split"),
  command_version: z.literal(1),
  target_id: z.string().min(1).max(128),
  observed_revision: z.int().nonnegative(),
  receipt_draft_id: z.string().min(1).max(128),
  receipt_revision: z.int().min(1),
  allocation_digest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().min(8).max(128),
  replace_command_id: z.string().min(1).max(128).nullable(),
};

export const CreateReceiptSplitCommandSchema = z.object(receiptSplitCommandFields).strict();
export type CreateReceiptSplitCommand = z.infer<typeof CreateReceiptSplitCommandSchema>;
export const CreateMobileCommandSchema = z.union([
  CreateClassificationCommandSchema,
  CreateReceiptSplitCommandSchema,
]);
export type CreateMobileCommand = z.infer<typeof CreateMobileCommandSchema>;

const appliedResultFields = {
  status: z.literal("applied"),
  category_id: z.string().min(1).max(128).nullable(),
  subcategory_id: z.string().min(1).max(128).nullable(),
  classification_revision: z.int().nonnegative(),
};

export const ClassificationCommandResultSchema = z.union([
  z.object({
    ...appliedResultFields,
    requested_scope: z.enum(categorizationScopes),
    effective_scope: z.enum(categorizationScopes),
    affected_count: z.int().nonnegative(),
  }).strict(),
  z.object({
    ...appliedResultFields,
  }).strict(),
  z.object({
    status: z.literal("conflict"),
    category_id: z.string().min(1).max(128).nullable(),
    subcategory_id: z.string().min(1).max(128).nullable(),
    classification_revision: z.int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    error_code: z.string().min(1).max(80),
  }).strict(),
]);

export const ReceiptCommandResultSchema = z.union([
  z.object({
    status: z.literal("applied"),
    receipt_id: z.string().min(1).max(128),
    split_revision: z.int().nonnegative(),
    split_count: z.int().positive(),
  }).strict(),
  z.object({ status: z.literal("conflict"), split_revision: z.int().nonnegative() }).strict(),
  z.object({ status: z.literal("rejected"), error_code: z.string().min(1).max(80) }).strict(),
]);

export const CommandResultSchema = z.union([
  ClassificationCommandResultSchema,
  ReceiptCommandResultSchema,
]);

export type CommandResult = z.infer<typeof CommandResultSchema>;

export interface HouseholdMember {
  id: string;
  household_id: string;
  display_name: string;
  role: "member";
}

interface PublicMobileCommandBase {
  id: string;
  actor_member_id: string;
  target_id: string;
  observed_revision: number;
  status: MobileCommandStatus;
  supersedes_command_id: string | null;
  result: CommandResult | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  finished_at: string | null;
}

export type PublicMobileCommand = PublicMobileCommandBase & ({
  command_type: "transaction.set_classification";
  command_version: 1 | 2;
  category_id: string | null;
  subcategory_id: string | null;
  scope: CategorizationScope;
} | {
  command_type: "transaction.apply_receipt_split";
  command_version: 1;
  receipt_draft_id: string;
  receipt_revision: number;
  allocation_digest: string;
});

interface ClaimedCommandBase {
  id: string;
  actor_member_id: string;
  target_id: string;
  observed_revision: number;
  payload_digest: string;
  claim_token: string;
  expires_at: string;
}

export type ClaimedCommand = ClaimedCommandBase & ({
  command_type: "transaction.set_classification";
  command_version: 1 | 2;
  category_id: string | null;
  subcategory_id: string | null;
  scope: CategorizationScope;
} | {
  command_type: "transaction.apply_receipt_split";
  command_version: 1;
  receipt_draft_id: string;
  receipt_revision: number;
  allocation_digest: string;
});

export class MobileCommandStoreError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "MobileCommandStoreError";
  }
}

export function canonicalClassificationPayload(
  version: 1 | 2,
  categoryId: string | null,
  subcategoryId: string | null,
  scope: CategorizationScope,
): string {
  return version === 1
    ? JSON.stringify({ category_id: categoryId, subcategory_id: subcategoryId })
    : JSON.stringify({ category_id: categoryId, subcategory_id: subcategoryId, scope });
}

export function canonicalReceiptSplitPayload(
  receiptDraftId: string,
  receiptRevision: number,
  allocationDigest: string,
): string {
  return JSON.stringify({
    receipt_draft_id: receiptDraftId,
    receipt_revision: receiptRevision,
    allocation_digest: allocationDigest,
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
