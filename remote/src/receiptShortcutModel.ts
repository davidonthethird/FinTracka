import { z } from "zod";

export const ReceiptShortcutPageSchema = z.object({
  page_index: z.preprocess(
    (value) => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value,
    z.int().min(0).max(11),
  ),
  text: z.string().max(30_000).refine((value) => value.trim().length > 0, "blank page"),
}).strict();

export const ReceiptShortcutCaptureSchema = z.object({
  contract: z.literal("receipt_shortcut_capture/v1"),
  idempotency_key: z.string().refine((value) =>
    z.uuid().safeParse(value).success || /^[a-f0-9]{64}$/i.test(value),
  "idempotency key must be a UUID or SHA-256 digest"),
  shortcut_version: z.literal(1),
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

export type ReceiptShortcutCapture = z.infer<typeof ReceiptShortcutCaptureSchema>;

export interface ScanSession {
  token: string;
  expires_at: string;
}

export interface PublicReceiptImport {
  id: string;
  shortcut_version: 1;
  pages: ReceiptShortcutCapture["pages"];
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
  });
}
