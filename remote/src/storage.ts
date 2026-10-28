export interface ActiveManifest {
  snapshot_id: string;
  source_sequence: number;
  digest: string;
  published_at: string;
  previous_snapshot_id: string | null;
  idempotent: boolean;
}

export class StorageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function activateSnapshot(
  bucket: R2Bucket,
  payload: Uint8Array,
  digest: string,
): Promise<ActiveManifest> {
  const document = JSON.parse(new TextDecoder().decode(payload)) as { snapshot_id: string; source_sequence: number };
  const snapshotKey = `snapshots/${document.snapshot_id}.json`;
  const existing = await bucket.head(snapshotKey);
  if (existing?.customMetadata?.digest !== undefined && existing.customMetadata.digest !== digest) {
    throw new StorageError("SNAPSHOT_CONFLICT");
  }
  if (!existing) {
    const created = await bucket.put(snapshotKey, payload, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      customMetadata: { digest },
    });
    if (!created && (await bucket.head(snapshotKey))?.customMetadata?.digest !== digest) {
      throw new StorageError("SNAPSHOT_CONFLICT");
    }
  }

  const currentObject = await bucket.get("active.json");
  const current = currentObject ? await currentObject.json<ActiveManifest>() : null;
  if (current?.snapshot_id === document.snapshot_id && current.digest === digest) {
    return { ...current, idempotent: true };
  }
  if (current && document.source_sequence <= current.source_sequence) {
    if (!existing) await bucket.delete(snapshotKey);
    throw new StorageError("SEQUENCE_CONFLICT");
  }

  const manifest: ActiveManifest = {
    snapshot_id: document.snapshot_id,
    source_sequence: document.source_sequence,
    digest,
    published_at: new Date().toISOString(),
    previous_snapshot_id: current?.snapshot_id ?? null,
    idempotent: false,
  };
  let activated: R2Object | null;
  try {
    activated = await bucket.put("active.json", JSON.stringify(manifest), {
      onlyIf: currentObject ? { etagMatches: currentObject.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  } catch (error) {
    const observed = await readActive(bucket);
    if (observed?.snapshot_id === document.snapshot_id && observed.digest === digest) {
      return { ...observed, idempotent: true };
    }
    throw error;
  }
  if (!activated) {
    const observed = await readActive(bucket);
    if (observed?.snapshot_id === document.snapshot_id && observed.digest === digest) {
      return { ...observed, idempotent: true };
    }
    if (!existing) await bucket.delete(snapshotKey);
    throw new StorageError("SEQUENCE_CONFLICT");
  }
  await retainActiveAndPrevious(bucket, manifest);
  return manifest;
}

export async function purgeSnapshots(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: "snapshots/", cursor });
    if (listed.objects.length) await bucket.delete(listed.objects.map((item) => item.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await bucket.delete("active.json");
}

async function readActive(bucket: R2Bucket): Promise<ActiveManifest | null> {
  const object = await bucket.get("active.json");
  return object ? object.json<ActiveManifest>() : null;
}

async function retainActiveAndPrevious(bucket: R2Bucket, manifest: ActiveManifest): Promise<void> {
  const keep = new Set([
    `snapshots/${manifest.snapshot_id}.json`,
    ...(manifest.previous_snapshot_id ? [`snapshots/${manifest.previous_snapshot_id}.json`] : []),
  ]);
  const listed = await bucket.list({ prefix: "snapshots/" });
  const remove = listed.objects.map((item) => item.key).filter((key) => !keep.has(key));
  if (remove.length) await bucket.delete(remove);
}
