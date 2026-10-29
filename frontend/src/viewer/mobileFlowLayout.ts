import type { FlowOwner } from "../reports/flow";
import type { FlowEntry, FlowGraph, FlowGroup } from "./ReportFlow";

export type MobileFlowOwner = "Everyone" | FlowOwner;
export type MobileFlowNodeKind = "source" | "hub" | "group" | "category" | "subcategory" | "terminal";

export interface MobileFlowItem {
  id: string;
  label: string;
  kind: MobileFlowNodeKind;
  amountMinor: number;
  percentBasisPoints: number;
  entryIds: string[];
  color: string;
  ownerBasisPoints?: Partial<Record<FlowOwner, number>>;
}

export interface MobileFlowSubcategory extends MobileFlowItem {
  kind: "subcategory";
  subcategoryId: string | null;
  categoryId: string | null;
}

export interface MobileFlowCategory extends MobileFlowItem {
  kind: "category";
  categoryId: string | null;
  children: MobileFlowSubcategory[];
}

export interface MobileFlowGroup extends MobileFlowItem {
  kind: "group";
  children: MobileFlowCategory[];
}

export interface MobileFlowModel {
  income: MobileFlowItem;
  sources: MobileFlowItem[];
  groups: MobileFlowGroup[];
  terminals: MobileFlowItem[];
  householdSpendingMinor: number;
  visibleSpendingMinor: number;
}

export interface MobileFlowPosition {
  id: string;
  kind: MobileFlowNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  item: MobileFlowItem;
}

export interface MobileFlowRibbon {
  id: string;
  sourceId: string;
  targetId: string;
  amountMinor: number;
  width: number;
  path: string;
  color: string;
  owner?: FlowOwner;
  entryIds: string[];
}

export interface MobileFlowLayout {
  width: number;
  height: number;
  nodes: MobileFlowPosition[];
  ribbons: MobileFlowRibbon[];
}

export interface MobileFlowLayoutOptions {
  width: number;
  expandedSource: boolean;
  expandedGroupIds: ReadonlySet<string>;
  expandedCategoryIds: ReadonlySet<string>;
  splitByOwner: boolean;
}

export const MIN_VISIBLE_RIBBON_PX = 2;
const MAX_RIBBON_PX = 30;
const MARGIN = 8;
const CARD_HEIGHT = 54;
const ROW_GAP = 10;

const owners: FlowOwner[] = ["David", "Ariela", "Shared"];

export function buildMobileFlowModel(
  report: FlowGraph,
  groups: FlowGroup[],
  owner: MobileFlowOwner,
): MobileFlowModel | null {
  if (!report.entries?.length || !groups.length || !validGraph(report)) return null;
  const entries = new Map(report.entries.map((entry) => [entry.id, entry]));
  const householdSpendingMinor = groups.reduce((sum, group) => sum + group.amount_minor, 0);

  const pendingGroups = groups.flatMap((group) => {
    const children = group.categories.flatMap((category) => {
      const categoryEntries = category.entry_ids
        .map((id) => entries.get(id))
        .filter((entry): entry is FlowEntry => Boolean(entry) && (owner === "Everyone" || entry!.spending_owner === owner));
      const amountMinor = expenseAmount(categoryEntries);
      if (amountMinor <= 0) return [];
      const childBuckets = new Map<string, { id: string | null; label: string; amount: number; entryIds: string[] }>();
      categoryEntries.forEach((entry) => {
        const key = entry.subcategory_id ?? "__none__";
        const bucket = childBuckets.get(key) ?? {
          id: entry.subcategory_id ?? null,
          label: entry.subcategory ?? "No subcategory",
          amount: 0,
          entryIds: [],
        };
        bucket.amount -= entry.amount_minor;
        bucket.entryIds.push(entry.id);
        childBuckets.set(key, bucket);
      });
      const positiveBuckets = [...childBuckets.values()].filter((bucket) => bucket.amount > 0);
      const childrenAmount = positiveBuckets.reduce((sum, bucket) => sum + bucket.amount, 0);
      const children: MobileFlowSubcategory[] = childrenAmount === amountMinor
        ? positiveBuckets.sort((left, right) => right.amount - left.amount || left.label.localeCompare(right.label)).map((bucket) => ({
          id: `${category.id}:subcategory:${bucket.id ?? "none"}`,
          label: bucket.label,
          kind: "subcategory",
          amountMinor: bucket.amount,
          percentBasisPoints: 0,
          entryIds: bucket.entryIds,
          color: category.color,
          ownerBasisPoints: ownerShares(bucket.entryIds.map((id) => entries.get(id)!).filter(Boolean)),
          subcategoryId: bucket.id,
          categoryId: category.categoryId,
        }))
        : [];
      return [{
        id: category.id,
        label: category.label,
        kind: "category" as const,
        amountMinor,
        percentBasisPoints: 0,
        entryIds: categoryEntries.map((entry) => entry.id),
        color: category.color,
        ownerBasisPoints: ownerShares(categoryEntries),
        categoryId: category.categoryId,
        children,
      }];
    });
    const amountMinor = children.reduce((sum, child) => sum + child.amountMinor, 0);
    if (amountMinor <= 0) return [];
    return [{
      id: group.id,
      label: group.label,
      kind: "group" as const,
      amountMinor,
      percentBasisPoints: 0,
      entryIds: children.flatMap((child) => child.entryIds),
      color: group.color,
      ownerBasisPoints: ownerShares(children.flatMap((child) => child.entryIds).map((id) => entries.get(id)!).filter(Boolean)),
      children,
    }];
  });
  const visibleSpendingMinor = pendingGroups.reduce((sum, group) => sum + group.amountMinor, 0);
  const withPercentages = pendingGroups.map((group) => ({
    ...group,
    percentBasisPoints: basisPoints(group.amountMinor, visibleSpendingMinor),
    children: group.children.map((category) => ({
      ...category,
      percentBasisPoints: basisPoints(category.amountMinor, visibleSpendingMinor),
      children: category.children.map((child) => ({
        ...child,
        percentBasisPoints: basisPoints(child.amountMinor, visibleSpendingMinor),
      })),
    })),
  }));
  const hubIndex = report.nodes.findIndex((node) => node.kind === "hub");
  if (hubIndex < 0) return null;
  const hub = report.nodes[hubIndex];
  const sources = report.links.flatMap((link) => {
    const node = link.target === hubIndex ? report.nodes[link.source] : undefined;
    return node && ["income", "refund", "funding"].includes(node.kind)
      ? [itemFromNode(node, "source", link.amount_minor, basisPoints(link.amount_minor, hub.amount_minor), node.kind === "funding" ? "#b47218" : "#147d70")]
      : [];
  });
  const terminals = report.links.flatMap((link) => {
    const node = link.source === hubIndex ? report.nodes[link.target] : undefined;
    return node && ["retained", "adjustment"].includes(node.kind)
      ? [itemFromNode(node, "terminal", link.amount_minor, basisPoints(link.amount_minor, hub.amount_minor), node.kind === "retained" ? "#147d70" : "#b47218")]
      : [];
  });

  return {
    income: itemFromNode(hub, "hub", hub.amount_minor, 10_000, "#147d70"),
    sources,
    groups: withPercentages,
    terminals,
    householdSpendingMinor,
    visibleSpendingMinor,
  };
}

export function layoutMobileFlow(
  model: MobileFlowModel,
  options: MobileFlowLayoutOptions,
): MobileFlowLayout {
  const width = Math.max(240, options.width);
  const nodes: MobileFlowPosition[] = [];
  const ribbons: MobileFlowRibbon[] = [];
  const positions = new Map<string, MobileFlowPosition>();
  const groupWidth = Math.max(104, Math.min(142, Math.round(width * 0.39)));
  const groupX = MARGIN + 22;
  const categoryX = groupX + groupWidth + 10;
  const categoryWidth = width - categoryX - MARGIN;
  let y = MARGIN;

  const addNode = (item: MobileFlowItem, x: number, top: number, nodeWidth: number) => {
    const position = { id: item.id, kind: item.kind, x, y: top, width: nodeWidth, height: CARD_HEIGHT, item };
    nodes.push(position);
    positions.set(item.id, position);
    return position;
  };

  const incomeWidth = Math.min(210, width - MARGIN * 2);
  addNode(model.income, MARGIN, y, incomeWidth);
  y += CARD_HEIGHT + ROW_GAP;

  if (options.expandedSource) {
    model.sources.forEach((source) => {
      addNode(source, MARGIN + 16, y, Math.min(190, width - MARGIN * 2 - 16));
      y += CARD_HEIGHT + ROW_GAP;
    });
    y += ROW_GAP;
  }

  model.groups.forEach((group) => {
    const blockStart = y;
    let childY = blockStart;
    if (options.expandedGroupIds.has(group.id)) {
      group.children.forEach((category) => {
        addNode(category, categoryX, childY, categoryWidth);
        childY += CARD_HEIGHT + ROW_GAP;
        if (options.expandedCategoryIds.has(category.id)) {
          category.children.forEach((subcategory) => {
            addNode(subcategory, categoryX + 12, childY, categoryWidth - 12);
            childY += CARD_HEIGHT + 6;
          });
        }
      });
    }
    const blockHeight = Math.max(CARD_HEIGHT, childY - blockStart - ROW_GAP);
    addNode(group, groupX, blockStart + Math.max(0, (blockHeight - CARD_HEIGHT) / 2), groupWidth);
    y = blockStart + blockHeight + ROW_GAP + 4;
  });

  model.terminals.forEach((terminal) => {
    addNode(terminal, groupX, y, Math.min(width - groupX - MARGIN, groupWidth + 42));
    y += CARD_HEIGHT + ROW_GAP;
  });

  const addRibbon = (sourceId: string, target: MobileFlowItem) => {
    const source = positions.get(sourceId);
    const targetPosition = positions.get(target.id);
    if (!source || !targetPosition || target.amountMinor <= 0) return;
    if (options.splitByOwner && target.ownerBasisPoints) {
      let assigned = 0;
      const shares = owners.flatMap((owner) => {
        const points = target.ownerBasisPoints?.[owner] ?? 0;
        return points > 0 ? [{ owner, points }] : [];
      });
      const buckets = shares.map((share, index) => {
        const amount = index === shares.length - 1
          ? target.amountMinor - assigned
          : Math.round(target.amountMinor * share.points / 10_000);
        assigned += amount;
        return { owner: share.owner, amount };
      });
      const totalWidth = buckets.reduce((sum, bucket) => sum + ribbonWidth(bucket.amount, model.visibleSpendingMinor || model.income.amountMinor), 0);
      let offset = -totalWidth / 2;
      buckets.forEach((bucket) => {
        const lineWidth = ribbonWidth(bucket.amount, model.visibleSpendingMinor || model.income.amountMinor);
        const centerOffset = offset + lineWidth / 2;
        ribbons.push(makeRibbon(source, targetPosition, target, lineWidth, ownerColor(bucket.owner), bucket.owner, centerOffset, bucket.amount));
        offset += lineWidth;
      });
      return;
    }
    ribbons.push(makeRibbon(
      source,
      targetPosition,
      target,
      ribbonWidth(target.amountMinor, target.kind === "source" ? model.income.amountMinor : model.visibleSpendingMinor || model.income.amountMinor),
      target.color,
    ));
  };

  if (options.expandedSource) model.sources.forEach((source) => addRibbon(model.income.id, source));
  model.groups.forEach((group) => {
    addRibbon(model.income.id, group);
    if (!options.expandedGroupIds.has(group.id)) return;
    group.children.forEach((category) => {
      addRibbon(group.id, category);
      if (options.expandedCategoryIds.has(category.id)) {
        category.children.forEach((subcategory) => addRibbon(category.id, subcategory));
      }
    });
  });
  model.terminals.forEach((terminal) => addRibbon(model.income.id, terminal));

  return { width, height: Math.max(y + MARGIN, CARD_HEIGHT + MARGIN * 2), nodes, ribbons };
}

function makeRibbon(
  source: MobileFlowPosition,
  target: MobileFlowPosition,
  item: MobileFlowItem,
  width: number,
  color: string,
  owner?: FlowOwner,
  offset = 0,
  amountMinor = item.amountMinor,
): MobileFlowRibbon {
  const horizontal = target.x >= source.x + source.width;
  const sourceX = horizontal ? source.x + source.width : source.x + source.width / 2;
  const sourceY = horizontal ? source.y + source.height / 2 + offset : source.y + source.height;
  const targetX = horizontal ? target.x : target.x + target.width / 2;
  const targetY = horizontal ? target.y + target.height / 2 + offset : target.y;
  const path = horizontal
    ? `M${sourceX},${sourceY} C${sourceX + (targetX - sourceX) * .45},${sourceY} ${targetX - (targetX - sourceX) * .45},${targetY} ${targetX},${targetY}`
    : `M${sourceX},${sourceY} C${sourceX},${sourceY + (targetY - sourceY) * .45} ${targetX},${targetY - (targetY - sourceY) * .45} ${targetX},${targetY}`;
  return {
    id: `${source.id}:${target.id}${owner ? `:${owner}` : ""}`,
    sourceId: source.id,
    targetId: target.id,
    amountMinor,
    width,
    path,
    color,
    owner,
    entryIds: item.entryIds,
  };
}

function ribbonWidth(amount: number, total: number): number {
  return Math.max(MIN_VISIBLE_RIBBON_PX, total > 0 ? amount / total * MAX_RIBBON_PX : MIN_VISIBLE_RIBBON_PX);
}

function ownerColor(owner: FlowOwner): string {
  if (owner === "David") return "#3277c8";
  if (owner === "Ariela") return "#d45d8d";
  return "#5b3f8c";
}

function validGraph(report: FlowGraph): boolean {
  const entries = new Set(report.entries?.map((entry) => entry.id));
  return report.links.every((link) => Number.isInteger(link.source) && Number.isInteger(link.target)
    && link.source >= 0 && link.target >= 0
    && link.source < report.nodes.length && link.target < report.nodes.length
    && link.amount_minor > 0 && link.entry_ids.every((id) => entries.has(id)));
}

function itemFromNode(
  node: FlowGraph["nodes"][number],
  kind: MobileFlowNodeKind,
  amountMinor: number,
  percentBasisPoints: number,
  color: string,
): MobileFlowItem {
  return { id: node.id, label: node.label, kind, amountMinor, percentBasisPoints, entryIds: node.entry_ids, color };
}

function expenseAmount(entries: FlowEntry[]): number {
  return -entries.reduce((sum, entry) => sum + entry.amount_minor, 0);
}

function basisPoints(amount: number, total: number): number {
  return total > 0 ? Math.round(amount / total * 10_000) : 0;
}

function ownerShares(entries: FlowEntry[]): Partial<Record<FlowOwner, number>> | undefined {
  const amounts = owners.map((owner) => ({
    owner,
    amount: expenseAmount(entries.filter((entry) => entry.spending_owner === owner)),
  })).filter((item) => item.amount > 0);
  const total = amounts.reduce((sum, item) => sum + item.amount, 0);
  if (!total) return undefined;
  let assigned = 0;
  return Object.fromEntries(amounts.map((item, index) => {
    const points = index === amounts.length - 1 ? 10_000 - assigned : basisPoints(item.amount, total);
    assigned += points;
    return [item.owner, points];
  })) as Partial<Record<FlowOwner, number>>;
}
