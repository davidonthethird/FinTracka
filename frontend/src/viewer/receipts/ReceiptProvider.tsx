import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { mobileJson } from "../api";
import { createReceipt, dismissReceipt, getReceipt, listReceipts, replaceReceipt } from "./receiptApi";
import type { ReceiptDraft, ReceiptDraftV1 } from "./types";

interface ReceiptContextValue {
  available: boolean;
  loading: boolean;
  drafts: ReceiptDraft[];
  error: string;
  refresh: () => Promise<void>;
  load: (id: string) => Promise<ReceiptDraft>;
  create: (draft: ReceiptDraftV1) => Promise<ReceiptDraft>;
  save: (current: ReceiptDraft, draft: ReceiptDraftV1) => Promise<ReceiptDraft>;
  dismiss: (current: ReceiptDraft) => Promise<void>;
}

const ReceiptContext = createContext<ReceiptContextValue | null>(null);

export function ReceiptProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<ReceiptDraft[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const session = await mobileJson<{ capabilities: { "receipts.drafts"?: [1] } }>("/api/v1/mobile/session");
      const supported = session.capabilities["receipts.drafts"]?.[0] === 1;
      setAvailable(supported);
      setDrafts(supported ? await listReceipts() : []);
      setError("");
    } catch (caught) {
      setAvailable(false);
      setError(caught instanceof Error ? caught.message : "Receipt drafts are unavailable.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);

  const create = useCallback(async (draft: ReceiptDraftV1) => {
    const result = await createReceipt(draft);
    setDrafts((current) => [result, ...current.filter((item) => item.id !== result.id)]);
    return result;
  }, []);
  const load = useCallback(async (id: string) => {
    const result = await getReceipt(id);
    setDrafts((current) => [result, ...current.filter((item) => item.id !== result.id)]);
    return result;
  }, []);
  const save = useCallback(async (current: ReceiptDraft, draft: ReceiptDraftV1) => {
    const result = await replaceReceipt(current.id, current.revision, draft);
    setDrafts((items) => items.map((item) => item.id === result.id ? result : item));
    return result;
  }, []);
  const dismiss = useCallback(async (current: ReceiptDraft) => {
    const result = await dismissReceipt(current.id, current.revision);
    setDrafts((items) => items.map((item) => item.id === result.id ? result : item));
  }, []);

  const value = useMemo(() => ({ available, loading, drafts, error, refresh, load, create, save, dismiss }),
    [available, create, dismiss, drafts, error, load, loading, refresh, save]);
  return <ReceiptContext.Provider value={value}>{children}</ReceiptContext.Provider>;
}

export function useReceipts(): ReceiptContextValue {
  const value = useContext(ReceiptContext);
  if (!value) throw new Error("ReceiptProvider is missing");
  return value;
}
