export type CategorizationScope = "one_time" | "future" | "past_and_future";

export const CATEGORIZATION_SCOPE_KEY = "fintracka-categorization-scope";

const scopes = new Set<CategorizationScope>(["one_time", "future", "past_and_future"]);

export function readCategorizationScope(
  storage?: Pick<Storage, "getItem">,
): CategorizationScope {
  try {
    const value = (storage || globalThis.localStorage).getItem(CATEGORIZATION_SCOPE_KEY);
    return value && scopes.has(value as CategorizationScope)
      ? value as CategorizationScope
      : "one_time";
  } catch {
    return "one_time";
  }
}

export function writeCategorizationScope(
  scope: CategorizationScope,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage || globalThis.localStorage).setItem(CATEGORIZATION_SCOPE_KEY, scope);
  } catch {
    // The preference is optional; categorization still works if storage is unavailable.
  }
}

export function effectiveCategorizationScope(
  scope: CategorizationScope,
  isCashWithdrawal: boolean,
): CategorizationScope {
  return isCashWithdrawal ? "one_time" : scope;
}

export function scopeMessage(scope: CategorizationScope): string {
  if (scope === "one_time") return "This choice applies once.";
  if (scope === "future") return "Future matches will follow it.";
  return "Past and future matches will follow it.";
}
