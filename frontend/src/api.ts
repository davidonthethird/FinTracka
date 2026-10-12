let csrfToken = "";

export async function bootstrapSession(): Promise<void> {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const bootstrap = hash.get("bootstrap");
  if (bootstrap) {
    const response = await fetch("/api/v1/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: bootstrap }),
    });
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!response.ok) throw new Error("The startup link has expired. Restart FinTracka and use the new link.");
  }
  const response = await fetch("/api/v1/session/csrf");
  if (!response.ok) throw new Error("Open FinTracka from the startup link shown in Terminal.");
  csrfToken = (await response.json()).csrf_token;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api/v1${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(typeof payload.detail === "string" ? payload.detail : "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
