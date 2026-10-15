export type FlowOwner = "David" | "Ariela" | "Shared";

type FlowReportLike = {
  nodes: { kind: string }[];
  links: FlowLink[];
  entries: { id: string; amount_minor: number; spending_owner?: string | null }[];
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
