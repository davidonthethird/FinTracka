export type FlowOwner = "David" | "Ariela" | "Shared";
export const FLOW_NODE_PADDING = 30;

export function flowChartHeight(nodeCount: number): number {
  return Math.max(560, nodeCount * 48);
}

type FlowReportLike = {
  nodes: { kind: string; amount_minor?: number; entry_ids?: string[] }[];
  links: FlowLink[];
  entries: { id: string; amount_minor: number; spending_owner?: string | null }[];
};

export type ExpenseNodeShare = {
  totalBasisPoints: number;
  ownerBasisPoints: Partial<Record<FlowOwner, number>>;
};

type FlowLink = {
  source: number;
  target: number;
  amount_minor: number;
  entry_ids: string[];
  owner?: FlowOwner;
};

export function splitLinksByOwner(report: FlowReportLike): FlowLink[] {
  const entries = new Map(report.entries.map((entry) => [entry.id, entry]));
  return report.links.flatMap((link) => {
    const target = report.nodes[link.target];
    if (!target || !["expense_group", "expense"].includes(target.kind)) return [link];
    const buckets = (["David", "Ariela", "Shared"] as FlowOwner[]).map((owner) => {
      const entryIds = link.entry_ids.filter((id) => entries.get(id)?.spending_owner === owner);
      const amount = entryIds.reduce((total, id) => total - (entries.get(id)?.amount_minor || 0), 0);
      return { owner, entry_ids: entryIds, amount };
    }).filter((bucket) => bucket.amount > 0);
    const rawTotal = buckets.reduce((total, bucket) => total + bucket.amount, 0);
    if (!rawTotal) return [link];
    let assigned = 0;
    return buckets.map((bucket, index) => {
      const amount = index === buckets.length - 1
        ? link.amount_minor - assigned
        : Math.round((link.amount_minor * bucket.amount) / rawTotal);
      assigned += amount;
      return { ...link, amount_minor: amount, entry_ids: bucket.entry_ids, owner: bucket.owner };
    }).filter((item) => item.amount_minor > 0);
  });
}

export function expenseNodeShares(report: FlowReportLike): Record<number, ExpenseNodeShare> {
  const entries = new Map(report.entries.map((entry) => [entry.id, entry]));
  const total = report.nodes.reduce(
    (sum, node) => sum + (node.kind === "expense" ? Math.max(node.amount_minor || 0, 0) : 0),
    0,
  );
  const result: Record<number, ExpenseNodeShare> = {};
  report.nodes.forEach((node, index) => {
    if (node.kind !== "expense" || !total) return;
    const amounts = (["David", "Ariela", "Shared"] as FlowOwner[]).map((owner) => ({
      owner,
      amount: (node.entry_ids || []).reduce((sum, id) => {
        const entry = entries.get(id);
        return entry?.spending_owner === owner ? sum - entry.amount_minor : sum;
      }, 0),
    })).filter((item) => item.amount > 0);
    const ownerTotal = amounts.reduce((sum, item) => sum + item.amount, 0);
    let assigned = 0;
    const ownerBasisPoints: Partial<Record<FlowOwner, number>> = {};
    amounts.forEach((item, ownerIndex) => {
      const points = ownerIndex === amounts.length - 1
        ? 10_000 - assigned
        : Math.round((item.amount / ownerTotal) * 10_000);
      assigned += points;
      ownerBasisPoints[item.owner] = points;
    });
    result[index] = {
      totalBasisPoints: Math.round(((node.amount_minor || 0) / total) * 10_000),
      ownerBasisPoints,
    };
  });
  return result;
}
