import { parseSnapshot, type RemoteSnapshot } from "./model";

export interface ViewerStatus {
  available: boolean;
  published_at?: string;
  stale?: boolean;
}

export class MobileCommandApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function loadRemoteData(): Promise<{ snapshot: RemoteSnapshot; status: ViewerStatus }> {
  const options: RequestInit = { cache: "no-store", credentials: "same-origin" };
  const [snapshotResponse, statusResponse] = await Promise.all([
    fetch("/api/v1/snapshot", options),
    fetch("/api/v1/status", options),
  ]);
  if (snapshotResponse.status === 404) {
    throw new Error("No snapshot has been published yet. Open FinTracka on your Mac to publish one.");
  }
  if (!snapshotResponse.ok || !statusResponse.ok) {
    throw new Error("The private viewer could not load the latest snapshot.");
  }
  return {
    snapshot: parseSnapshot(await snapshotResponse.json()),
    status: await statusResponse.json() as ViewerStatus,
  };
}

export async function mobileJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error_code?: string };
    const code = body.error_code || "MOBILE_GATEWAY_UNAVAILABLE";
    throw new MobileCommandApiError(response.status, code, humanMobileError(code));
  }
  return await response.json() as T;
}

function humanMobileError(code: string): string {
  if (code === "ACTIVE_COMMAND_EXISTS") return "Another proposed edit already exists. Refresh and choose Replace proposal.";
  if (code === "STALE_CLASSIFICATION") return "The classification changed. Refresh before trying again.";
  if (code === "COMMAND_NOT_CANCELLABLE") return "This edit is already being applied and can no longer be cancelled.";
  if (code === "TOO_MANY_PENDING_COMMANDS" || code === "COMMAND_RATE_LIMITED") return "Too many edits are waiting. Try again after your Mac processes them.";
  return "The edit could not be submitted. Try again.";
}
