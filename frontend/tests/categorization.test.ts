import { describe, expect, test } from "vitest";

import {
  effectiveCategorizationScope,
  readCategorizationScope,
  writeCategorizationScope,
  type CategorizationScope,
} from "../src/transactions/categorization";

function memoryStorage(initial?: string) {
  let value = initial;
  return {
    getItem: () => value ?? null,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

describe("categorization scope preference", () => {
  test("defaults missing and invalid preferences to one transaction", () => {
    expect(readCategorizationScope(memoryStorage())).toBe("one_time");
    expect(readCategorizationScope(memoryStorage("unexpected"))).toBe("one_time");
  });

  test("falls back safely when browser storage is unavailable", () => {
    const unavailable = { getItem: () => { throw new Error("blocked"); } };
    expect(readCategorizationScope(unavailable)).toBe("one_time");
  });

  test.each<CategorizationScope>(["one_time", "future", "past_and_future"])(
    "round-trips %s",
    (scope) => {
      const storage = memoryStorage();
      writeCategorizationScope(scope, storage);
      expect(readCategorizationScope(storage)).toBe(scope);
    },
  );

  test("forces cash withdrawals to one-time categorization", () => {
    expect(effectiveCategorizationScope("past_and_future", true)).toBe("one_time");
    expect(effectiveCategorizationScope("future", false)).toBe("future");
  });
});
