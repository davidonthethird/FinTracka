import { z } from "zod";

export const commandStatuses = [
  "pending", "processing", "applied", "conflict", "rejected",
  "cancelled", "expired", "superseded",
] as const;

export type MobileCommandStatus = typeof commandStatuses[number];

export const CreateClassificationCommandSchema = z.object({
  command_type: z.literal("transaction.set_classification"),
  command_version: z.literal(1),
  target_id: z.string().min(1).max(128),
  observed_revision: z.int().nonnegative(),
  category_id: z.string().min(1).max(128).nullable(),
  subcategory_id: z.string().min(1).max(128).nullable(),
  idempotency_key: z.string().min(8).max(128),
  replace_command_id: z.string().min(1).max(128).nullable(),
}).strict().superRefine((value, context) => {
  if (value.category_id === null && value.subcategory_id !== null) {
    context.addIssue({
      code: "custom",
      message: "subcategory requires a category",
      path: ["subcategory_id"],
    });
  }
});

export type CreateClassificationCommand = z.infer<typeof CreateClassificationCommandSchema>;

export const CommandResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("applied"),
    category_id: z.string().min(1).max(128).nullable(),
    subcategory_id: z.string().min(1).max(128).nullable(),
    classification_revision: z.int().nonnegative(),
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

export type CommandResult = z.infer<typeof CommandResultSchema>;

export interface HouseholdMember {
  id: string;
  household_id: string;
  display_name: string;
  role: "member";
}

export interface PublicMobileCommand {
  id: string;
  actor_member_id: string;
  command_type: "transaction.set_classification";
  command_version: 1;
  target_id: string;
  observed_revision: number;
  category_id: string | null;
  subcategory_id: string | null;
  status: MobileCommandStatus;
  supersedes_command_id: string | null;
  result: CommandResult | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  finished_at: string | null;
}

export interface ClaimedCommand {
  id: string;
  actor_member_id: string;
  command_type: "transaction.set_classification";
  command_version: 1;
  target_id: string;
  observed_revision: number;
  category_id: string | null;
  subcategory_id: string | null;
  payload_digest: string;
  claim_token: string;
  expires_at: string;
}

export class MobileCommandStoreError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "MobileCommandStoreError";
  }
}

export function canonicalClassificationPayload(
  categoryId: string | null,
  subcategoryId: string | null,
): string {
  return JSON.stringify({ category_id: categoryId, subcategory_id: subcategoryId });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
