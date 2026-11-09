import { z } from "zod";

import { ReceiptInterpretationSchema, type ReceiptValidationResult } from "./receiptInterpretation";
import {
  compareReceiptModelRuns,
  type ReceiptModelComparison,
  type ReceiptModelRoute,
} from "./receiptModelComparison";

const idempotencyKey = z.string().refine((value) =>
  z.uuid().safeParse(value).success || /^[a-f0-9]{64}$/i.test(value),
"idempotency key must be a UUID or SHA-256 digest");

export const ReceiptShortcutPageSchema = z.object({
  page_index: z.preprocess(
    (value) => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value,
    z.int().min(0).max(11),
  ),
  text: z.string().max(30_000).refine((value) => value.trim().length > 0, "blank page"),
}).strict();

const ReceiptShortcutCaptureBase = z.object({
  contract: z.literal("receipt_shortcut_capture/v1"),
  idempotency_key: idempotencyKey,
  shortcut_version: z.literal(1),
});

const ReceiptShortcutPagesCaptureSchema = ReceiptShortcutCaptureBase.extend({
  pages: z.array(ReceiptShortcutPageSchema).min(1).max(12),
}).strict().superRefine((capture, context) => {
  let characters = 0;
  capture.pages.forEach((page, index) => {
    characters += page.text.length;
    if (page.page_index !== index) {
      context.addIssue({ code: "custom", path: ["pages", index, "page_index"],
        message: "pages must be ordered from zero" });
    }
  });
  if (characters > 100_000) {
    context.addIssue({ code: "custom", path: ["pages"], message: "receipt text is too large" });
  }
});

const ReceiptShortcutTextCaptureSchema = ReceiptShortcutCaptureBase.extend({
  text: z.string().max(100_000).refine((value) => value.trim().length > 0, "blank receipt"),
}).strict().transform(({ text, ...capture }) => ({
  ...capture,
  pages: [{ page_index: 0, text }],
}));

export const ReceiptShortcutCaptureV2Schema = z.object({
  contract: z.literal("receipt_shortcut_capture/v2"),
  idempotency_key: ReceiptShortcutCaptureBase.shape.idempotency_key,
  shortcut_version: z.literal(2),
  text: z.string().max(100_000).refine((value) => value.trim().length > 0, "blank receipt"),
  model_result: z.union([z.string().max(100_000), ReceiptInterpretationSchema])
    .transform((value) => typeof value === "string" ? value : JSON.stringify(value)),
}).strict().transform(({ text, ...capture }) => ({
  ...capture,
  pages: [{ page_index: 0, text }],
}));

const modelRoute = z.enum(["on_device", "private_cloud_compute"]);
const duration = z.int().min(0).max(3_600_000);
const shortcutNumber = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.replaceAll(",", "").trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return value;
    return Math.round(Number(normalized));
  },
  schema,
);
const safeErrorCode = z.enum(["MODEL_UNAVAILABLE", "MODEL_RATE_LIMITED", "MODEL_FAILED"]);

export const ReceiptModelRunSchema = z.discriminatedUnion("status", [
  z.object({ model: modelRoute, status: z.literal("completed"), duration_ms: duration,
    model_result: z.string().max(100_000) }).strict(),
  z.object({ model: modelRoute, status: z.enum(["unavailable", "rate_limited", "failed"]),
    duration_ms: duration, error_code: safeErrorCode }).strict(),
]);

export const ReceiptShortcutCaptureV3Schema = z.object({
  contract: z.literal("receipt_shortcut_capture/v3"),
  idempotency_key: idempotencyKey,
  shortcut_version: shortcutNumber(z.literal(3)),
  text: z.string().max(100_000).refine((value) => value.trim().length > 0, "blank receipt"),
  runs: z.array(ReceiptModelRunSchema).length(2),
}).strict().superRefine((capture, context) => {
  const routes = new Set(capture.runs.map((run) => run.model));
  if (routes.size !== 2 || !routes.has("on_device") || !routes.has("private_cloud_compute")) {
    context.addIssue({ code: "custom", path: ["runs"], message: "one run per model route is required" });
  }
}).transform(({ text, ...capture }) => ({ ...capture, pages: [{ page_index: 0, text }] }));

const flatRunStatus = z.enum(["completed", "unavailable", "rate_limited", "failed"]);
type FlatRunStatus = z.infer<typeof flatRunStatus>;
type FlatRoute = "on_device" | "private_cloud_compute";
interface FlatCaptureInput {
  contract: "receipt_shortcut_capture/v3";
  idempotency_key: string;
  shortcut_version: 3;
  text: string;
  on_device_status: FlatRunStatus;
  on_device_duration_ms: number;
  on_device_model_result?: string;
  on_device_error_code?: z.infer<typeof safeErrorCode>;
  private_cloud_compute_status: FlatRunStatus;
  private_cloud_compute_duration_ms: number;
  private_cloud_compute_model_result?: string;
  private_cloud_compute_error_code?: z.infer<typeof safeErrorCode>;
}

export const ReceiptShortcutFlatCaptureV3Schema = z.object({
  contract: z.literal("receipt_shortcut_capture/v3"),
  idempotency_key: idempotencyKey,
  shortcut_version: shortcutNumber(z.literal(3)),
  text: z.string().max(100_000).refine((value) => value.trim().length > 0, "blank receipt"),
  on_device_status: flatRunStatus,
  on_device_duration_ms: shortcutNumber(duration),
  on_device_model_result: z.string().max(100_000).optional(),
  on_device_error_code: safeErrorCode.optional(),
  private_cloud_compute_status: flatRunStatus,
  private_cloud_compute_duration_ms: shortcutNumber(duration),
  private_cloud_compute_model_result: z.string().max(100_000).optional(),
  private_cloud_compute_error_code: safeErrorCode.optional(),
}).strict().superRefine((capture, context) => {
  validateFlatRun(capture, "on_device", context);
  validateFlatRun(capture, "private_cloud_compute", context);
}).transform((capture) => ({
  contract: capture.contract,
  idempotency_key: capture.idempotency_key,
  shortcut_version: capture.shortcut_version,
  pages: [{ page_index: 0, text: capture.text }],
  runs: [flatRun(capture, "on_device"), flatRun(capture, "private_cloud_compute")],
}));

export const ReceiptShortcutCaptureSchema = z.union([
  ReceiptShortcutPagesCaptureSchema,
  ReceiptShortcutTextCaptureSchema,
  ReceiptShortcutCaptureV2Schema,
  ReceiptShortcutCaptureV3Schema,
  ReceiptShortcutFlatCaptureV3Schema,
]);

export type ReceiptShortcutCapture = z.infer<typeof ReceiptShortcutCaptureSchema>;

export interface ScanSession {
  token: string;
  expires_at: string;
}

export interface PublicReceiptImport {
  id: string;
  shortcut_version: 1 | 2 | 3;
  pages: ReceiptShortcutCapture["pages"];
  validation: ReceiptValidationResult | null;
  comparison?: ReceiptModelComparison | null;
  selection?: ReceiptModelRoute | "tie" | "neither" | null;
  refinement: { id: string; status: "pending" | "claimed" | "completed" | "failed";
    error_code: string | null } | null;
  created_at: string;
  expires_at: string;
}

export function canonicalReceiptShortcutCapture(value: unknown): string {
  const capture = ReceiptShortcutCaptureSchema.parse(value);
  return JSON.stringify({
    contract: capture.contract,
    idempotency_key: capture.idempotency_key,
    shortcut_version: capture.shortcut_version,
    pages: capture.pages.map((page) => ({ page_index: page.page_index, text: page.text })),
    ...(capture.shortcut_version === 2 ? { model_result: capture.model_result } : {}),
    ...(capture.shortcut_version === 3 ? { runs: capture.runs } : {}),
  });
}

export function compareCapture(capture: Extract<ReceiptShortcutCapture, { shortcut_version: 3 }>) {
  return compareReceiptModelRuns(capture.pages[0].text, capture.runs);
}

function validateFlatRun(capture: FlatCaptureInput, route: FlatRoute, context: z.RefinementCtx): void {
  const status = capture[`${route}_status`];
  const result = capture[`${route}_model_result`];
  const error = capture[`${route}_error_code`];
  if (status === "completed" && (result === undefined || error !== undefined)) {
    context.addIssue({ code: "custom", path: [`${route}_model_result`],
      message: "completed runs require only a model result" });
  }
  if (status !== "completed" && (error === undefined || result !== undefined)) {
    context.addIssue({ code: "custom", path: [`${route}_error_code`],
      message: "incomplete runs require only an error code" });
  }
}

function flatRun(capture: FlatCaptureInput, route: FlatRoute): z.infer<typeof ReceiptModelRunSchema> {
  const duration_ms = capture[`${route}_duration_ms`];
  const status = capture[`${route}_status`];
  if (status === "completed") {
    return { model: route, status: "completed", duration_ms,
      model_result: capture[`${route}_model_result`]! };
  }
  return { model: route, status, duration_ms,
    error_code: capture[`${route}_error_code`]! };
}
