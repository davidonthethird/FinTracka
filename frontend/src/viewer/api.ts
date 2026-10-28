import { parseSnapshot, type RemoteSnapshot } from "./model";

export interface ViewerStatus {
  available: boolean;
  published_at?: string;
  stale?: boolean;
}

export async function loadRemoteData(): Promise<{ snapshot: RemoteSnapshot; status: ViewerStatus }> {
  const options: RequestInit = { cache: "no-store", credentials: "same-origin" };
  const [snapshotResponse, statusResponse] = await Promise.all([
    fetch("/api/v1/snapshot", options),
    fetch("/api/v1/status", options),
  ]);
  if (!snapshotResponse.ok || !statusResponse.ok) {
    throw new Error("The private viewer could not load the latest snapshot.");
  }
  return {
    snapshot: parseSnapshot(await snapshotResponse.json()),
    status: await statusResponse.json() as ViewerStatus,
  };
}
