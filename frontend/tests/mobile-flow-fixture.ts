import type { FlowGraph } from "../src/viewer/ReportFlow";

export function reportFixture(): FlowGraph {
  const entry = (id: string, amount: number, category: string, categoryId: string, subcategoryId: string | null, subcategory: string | null, owner: "David" | "Ariela" | "Shared" | null) => ({
    id, transaction_id: `t-${id}`, local_date: "2026-10-01", merchant: id,
    description: id, category, category_id: categoryId, subcategory_id: subcategoryId,
    subcategory, amount_minor: amount, currency: "USD", spending_owner: owner,
  });
  return {
    nodes: [
      { id: "income", label: "Income", kind: "hub", amount_minor: 17_000, entry_ids: ["salary"] },
      { id: "income:salary", label: "Salary", kind: "income", amount_minor: 15_000, entry_ids: ["salary"] },
      { id: "funding-gap", label: "Prior cash", kind: "funding", amount_minor: 2_000, entry_ids: [] },
      { id: "group:essentials", label: "Essentials", kind: "expense_group", amount_minor: 6_000, entry_ids: ["g1", "g2", "g3", "u1"] },
      { id: "expense:groceries", label: "Groceries", kind: "expense", amount_minor: 4_000, entry_ids: ["g1", "g2", "g3"] },
      { id: "expense:utilities", label: "Utilities", kind: "expense", amount_minor: 2_000, entry_ids: ["u1"] },
      { id: "group:lifestyle", label: "Lifestyle", kind: "expense_group", amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { id: "expense:shopping", label: "Shopping", kind: "expense", amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { id: "retained", label: "Money retained", kind: "retained", amount_minor: 8_000, entry_ids: ["salary"] },
    ],
    links: [
      { source: 1, target: 0, amount_minor: 15_000, entry_ids: ["salary"] },
      { source: 2, target: 0, amount_minor: 2_000, entry_ids: [] },
      { source: 0, target: 3, amount_minor: 6_000, entry_ids: ["g1", "g2", "g3", "u1"] },
      { source: 3, target: 4, amount_minor: 4_000, entry_ids: ["g1", "g2", "g3"] },
      { source: 3, target: 5, amount_minor: 2_000, entry_ids: ["u1"] },
      { source: 0, target: 6, amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { source: 6, target: 7, amount_minor: 3_000, entry_ids: ["s1", "s2"] },
      { source: 0, target: 8, amount_minor: 8_000, entry_ids: ["salary"] },
    ],
    entries: [
      entry("salary", 15_000, "Salary", "salary", null, null, null),
      entry("g1", -3_000, "Groceries", "groceries", "food", "Food", "David"),
      entry("g2", 500, "Groceries", "groceries", "food", "Food", "David"),
      entry("g3", -1_500, "Groceries", "groceries", null, null, "Shared"),
      entry("u1", -2_000, "Utilities", "utilities", "electric", "Electric", "Ariela"),
      entry("s1", -1_000, "Shopping", "shopping", "clothes", "Clothes", "David"),
      entry("s2", -2_000, "Shopping", "shopping", "household", "Household", "Ariela"),
    ],
  } as FlowGraph;
}
