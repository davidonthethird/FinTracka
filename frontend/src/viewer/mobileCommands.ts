import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ClassificationTaxonomy, RemoteSnapshot, RemoteTransaction } from "./model";
import { supportsMobileClassification } from "./model";
import { MobileCommandApiError, mobileJson } from "./api";

export type MobileCommandStatus = "pending" | "processing" | "applied" | "conflict" | "rejected" | "cancelled" | "expired" | "superseded";
export type MobileCommandResult =
  | { status: "applied" | "conflict"; category_id: string | null; subcategory_id: string | null; classification_revision: number }
  | { status: "rejected"; error_code: string };

export interface MobileCommand {
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
  result: MobileCommandResult | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  finished_at: string | null;
}

interface MobileSession {
  member: { id: string; display_name: string };
  capabilities: { "transaction.set_classification"?: [1] };
  server_time: string;
}

interface ClassificationInput {
  transaction: RemoteTransaction;
  categoryId: string | null;
  subcategoryId: string | null;
  replaceCommandId?: string | null;
  observedRevision?: number;
}

interface MobileCommandContextValue {
  available: boolean;
  loading: boolean;
  memberName?: string;
  commands: MobileCommand[];
  error: string;
  refresh: () => Promise<void>;
  save: (input: ClassificationInput) => Promise<MobileCommand>;
  cancel: (commandId: string) => Promise<void>;
}

const MobileCommandContext = createContext<MobileCommandContextValue | null>(null);

export function MobileCommandProvider({ snapshot, onSnapshotRefresh, children }: {
  snapshot: RemoteSnapshot;
  onSnapshotRefresh: () => Promise<void>;
  children: ReactNode;
}) {
  const supported = supportsMobileClassification(snapshot);
  const [session, setSession] = useState<MobileSession>();
  const [commands, setCommands] = useState<MobileCommand[]>([]);
  const [loading, setLoading] = useState(supported);
  const [error, setError] = useState("");
  const snapshotRef = useRef(snapshot);
  const snapshotRefreshRef = useRef(onSnapshotRefresh);
  snapshotRef.current = snapshot;
  snapshotRefreshRef.current = onSnapshotRefresh;
  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const [nextSession, response] = await Promise.all([
        mobileJson<MobileSession>("/api/v1/mobile/session"),
        mobileJson<{ commands: MobileCommand[] }>("/api/v1/mobile/commands"),
      ]);
      setSession(nextSession);
      setCommands(response.commands);
      setError("");
      const awaitingCommittedSnapshot = response.commands.some(
        (item) => item.status === "applied"
          && !appliedCommandMatchesSnapshot(item, snapshotRef.current),
      );
      if (awaitingCommittedSnapshot) {
        await snapshotRefreshRef.current();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Phone editing is temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) { setSession(undefined); setCommands([]); setLoading(false); setError(""); return; }
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh, supported]);

  const save = useCallback(async (input: ClassificationInput) => {
    const idempotencyKey = crypto.randomUUID();
    const body = {
      command_type: "transaction.set_classification" as const,
      command_version: 1 as const,
      target_id: input.transaction.id,
      observed_revision: input.observedRevision ?? input.transaction.classification_revision ?? 0,
      category_id: input.categoryId,
      subcategory_id: input.subcategoryId,
      idempotency_key: idempotencyKey,
      replace_command_id: input.replaceCommandId ?? null,
    };
    let response: { command: MobileCommand };
    try {
      response = await mobileJson<{ command: MobileCommand }>("/api/v1/mobile/commands", { method: "POST", body: JSON.stringify(body) });
    } catch (firstError) {
      if (firstError instanceof MobileCommandApiError && firstError.status < 500) throw firstError;
      response = await mobileJson<{ command: MobileCommand }>("/api/v1/mobile/commands", { method: "POST", body: JSON.stringify(body) });
    }
    setCommands((current) => [
      response.command,
      ...current.filter((item) => item.id !== response.command.id).map((item) =>
        item.id === input.replaceCommandId ? { ...item, status: "superseded" as const } : item),
    ]);
    setError("");
    return response.command;
  }, []);

  const cancel = useCallback(async (commandId: string) => {
    const response = await mobileJson<{ command: MobileCommand }>(`/api/v1/mobile/commands/${encodeURIComponent(commandId)}/cancel`, { method: "POST", body: "{}" });
    setCommands((current) => current.map((item) => item.id === response.command.id ? response.command : item));
  }, []);

  const value = useMemo<MobileCommandContextValue>(() => ({
    available: supported && session?.capabilities["transaction.set_classification"]?.[0] === 1,
    loading, memberName: session?.member.display_name, commands, error, refresh, save, cancel,
  }), [cancel, commands, error, loading, refresh, save, session, supported]);
  return createElement(MobileCommandContext.Provider, { value }, children);
}

export function useMobileCommands(): MobileCommandContextValue {
  const value = useContext(MobileCommandContext);
  if (!value) throw new Error("MobileCommandProvider is missing");
  return value;
}

export function activeCommandForTransaction(commands: MobileCommand[], transactionId: string): MobileCommand | undefined {
  return commands
    .filter((item) => item.target_id === transactionId && (item.status === "pending" || item.status === "processing"))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
}

export function latestCommandForTransaction(commands: MobileCommand[], transactionId: string): MobileCommand | undefined {
  return commands.filter((item) => item.target_id === transactionId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
}

export function appliedCommandMatchesSnapshot(
  command: MobileCommand,
  snapshot: RemoteSnapshot,
): boolean {
  if (command.status !== "applied" || command.result?.status !== "applied") return false;
  const transaction = snapshot.transactions.find((item) => item.id === command.target_id);
  return transaction?.classification_revision === command.result.classification_revision
    && transaction.category_id === command.result.category_id
    && transaction.subcategory_id === command.result.subcategory_id;
}

export function proposedClassification(command: MobileCommand, taxonomy: ClassificationTaxonomy | null): {
  category: string; subcategory: string | null; pending: boolean;
} {
  const category = command.category_id === null
    ? "Uncategorized"
    : taxonomy?.categories.find((item) => item.id === command.category_id)?.name ?? "Unavailable category";
  const subcategory = command.subcategory_id === null
    ? null
    : taxonomy?.subcategories.find((item) => item.id === command.subcategory_id)?.name ?? "Unavailable subcategory";
  return { category, subcategory, pending: command.status === "pending" || command.status === "processing" };
}

export function statusLabel(status: MobileCommandStatus): string {
  return ({
    pending: "Pending", processing: "Applying", applied: "Applied",
    conflict: "Needs review", rejected: "Rejected", cancelled: "Cancelled",
    expired: "Expired", superseded: "Replaced",
  })[status];
}

