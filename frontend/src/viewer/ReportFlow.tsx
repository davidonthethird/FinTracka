import { useMemo, useState } from "react";
import { ResponsiveContainer, Sankey } from "recharts";
import type { SankeyNodeProps } from "recharts";
import { formatMoney } from "../format";
import { flowChartHeight, type FlowOwner } from "../reports/flow";
import { MobileExpandableSankey } from "./MobileExpandableSankey";

export type FlowNode = { id: string; label: string; kind: string; amount_minor: number; entry_ids: string[] };
export type FlowLink = { source: number; target: number; amount_minor: number; entry_ids: string[] };
export type FlowEntry = { id: string; transaction_id: string; local_date: string; merchant: string | null; description: string; category: string; category_id: string | null; subcategory_id?: string | null; subcategory?: string | null; amount_minor: number; currency: string; spending_owner: string | null };
export type FlowGraph = { nodes: FlowNode[]; links: FlowLink[]; entries?: FlowEntry[] };
export type FlowSelection = { categoryId: string | null; subcategoryId?: string | null; label: string; amountMinor: number; entryIds: string[]; owner?: FlowOwner };
export type ExpectedCategory = { category_id: string | null; category: string; amount_minor: number };

export type FlowCategory = FlowNode & { categoryId: string | null; groupId: string; color: string };
export type FlowGroup = FlowNode & { color: string; categories: FlowCategory[] };

const colors = ["#e97745", "#53a86f", "#d45d8d", "#4f8edc", "#8c65c8", "#d9a62e", "#147d70"];

export function buildFlowGroups(report?: FlowGraph, expected?: ExpectedCategory[]): FlowGroup[] {
  if (!report?.nodes || !report.links || !report.entries) return [];
  if (report.links.some((link) => !Number.isInteger(link.source) || !Number.isInteger(link.target) || link.source < 0 || link.target < 0 || link.source >= report.nodes.length || link.target >= report.nodes.length || link.amount_minor <= 0)) return [];
  const groups = report.nodes.flatMap((node, index) => node.kind === "expense_group" ? [{ node, index }] : []);
  const result = groups.map(({ node, index }, groupIndex) => ({
    ...node,
    color: colors[groupIndex % colors.length],
    categories: report.links.flatMap((link) => {
      const category = link.source === index ? report.nodes[link.target] : undefined;
      if (!category || category.kind !== "expense") return [];
      const rawId = category.id.startsWith("expense:") ? category.id.slice("expense:".length) : category.id;
      return [{
        ...category,
        categoryId: rawId === "uncategorized-expense" ? null : rawId,
        groupId: node.id,
        color: colors[groupIndex % colors.length],
      }];
    }),
  })).filter((group) => group.amount_minor > 0 && group.categories.length > 0 && group.categories.reduce((sum, category) => sum + category.amount_minor, 0) === group.amount_minor);
  const entries = new Map(report.entries.map((entry) => [entry.id, entry]));
  if (result.some((group) => group.categories.some((category) => !category.entry_ids.length || category.entry_ids.some((id) => !entries.has(id)) || -category.entry_ids.reduce((sum, id) => sum + (entries.get(id)?.amount_minor ?? 0), 0) !== category.amount_minor))) return [];
  if (expected) {
    const categories = result.flatMap((group) => group.categories);
    const wanted = expected.filter((category) => category.amount_minor > 0);
    if (categories.length !== wanted.length || wanted.some((item) => !categories.some((category) => category.categoryId === item.category_id && category.label === item.category && category.amount_minor === item.amount_minor))) return [];
  }
  return result;
}

export function ReportFlow({ report, expectedCategories, onCategory }: {
  report?: FlowGraph;
  expectedCategories?: ExpectedCategory[];
  onCategory: (selection: FlowSelection) => void;
}) {
  const groups = useMemo(() => buildFlowGroups(report, expectedCategories), [report, expectedCategories]);
  const [focusedGroupId, setFocusedGroupId] = useState<string>();
  const focusedGroup = groups.find((group) => group.id === focusedGroupId);

  if (!groups.length || !report) return <div className="flow-unavailable"><strong>Detailed flow is not available</strong><span>The category totals below still show this month’s spending.</span></div>;

  return <div className="report-flow-map" aria-label="Expandable financial flow">
    <div className="mobile-flow-map"><MobileExpandableSankey report={report} groups={groups} onSelect={onCategory} /></div>
    <div className="desktop-flow-map">
      <div className="flow-zoom-bar">
        <span>{focusedGroup ? <><button onClick={() => setFocusedGroupId(undefined)}>All spending</button><b aria-hidden="true">›</b><strong>{focusedGroup.label}</strong></> : <strong>All spending</strong>}</span>
        {focusedGroup && <button className="flow-reset" onClick={() => setFocusedGroupId(undefined)}>Reset view</button>}
      </div>
      <div className="flow-sankey" aria-label="Connected income and spending flow">
        <DesktopFlow report={report} groups={groups} focusedGroup={focusedGroup} onFocus={setFocusedGroupId} onCategory={onCategory} />
      </div>
    </div>
  </div>;
}

function DesktopFlow({ report, groups, focusedGroup, onFocus, onCategory }: {
  report: FlowGraph;
  groups: FlowGroup[];
  focusedGroup?: FlowGroup;
  onFocus: (id: string) => void;
  onCategory: (selection: FlowSelection) => void;
}) {
  const groupIds = new Set((focusedGroup ? [focusedGroup] : groups).map((group) => group.id));
  const categoryIds = new Set((focusedGroup ? focusedGroup.categories : groups.flatMap((group) => group.categories)).map((category) => category.id));
  const included = report.nodes.map((node) => node.kind === "hub" || groupIds.has(node.id) || categoryIds.has(node.id) || (!focusedGroup && ["income", "refund", "funding", "retained", "adjustment"].includes(node.kind)));
  const indexes = new Map<number, number>();
  const nodeColors = new Map(groups.flatMap((group) => [[group.id, group.color] as const, ...group.categories.map((category) => [category.id, category.color] as const)]));
  const nodes = report.nodes.flatMap((node, index) => {
    if (!included[index]) return [];
    indexes.set(index, indexes.size);
    return [{ ...node, color: nodeColors.get(node.id) || (node.kind === "hub" ? "#147d70" : "#b47218") }];
  });
  const links = report.links.flatMap((link) => {
    const source = indexes.get(link.source); const target = indexes.get(link.target);
    return source === undefined || target === undefined ? [] : [{ ...link, source, target, value: link.amount_minor }];
  });
  return <div style={{ height: flowChartHeight(nodes.length) }}>
    <ResponsiveContainer width="100%" height="100%">
      <Sankey data={{ nodes, links }} iterations={0} sort={false} verticalAlign="top" nodePadding={24} nodeWidth={9} linkCurvature={0.42} margin={{ top: 18, right: 165, bottom: 18, left: 115 }} node={(props) => <FlowNodeShape {...props} onGroupFocus={onFocus} onCategory={onCategory} />} />
    </ResponsiveContainer>
  </div>;
}

function FlowNodeShape({ payload, x, y, width, height, onGroupFocus, onCategory }: SankeyNodeProps & {
  onGroupFocus: (id: string) => void;
  onCategory: (selection: FlowSelection) => void;
}) {
  const node = payload as typeof payload & FlowNode & { color: string };
  const activate = node.kind === "expense_group"
    ? () => onGroupFocus(node.id)
    : node.kind === "expense"
      ? () => onCategory(selectionFor({ ...node, categoryId: node.id.slice("expense:".length) === "uncategorized-expense" ? null : node.id.slice("expense:".length) }))
      : undefined;
  const labelX = x + width + 7;
  const rect = <rect x={x} y={y} width={Math.max(width, 11)} height={Math.max(height, 7)} fill={node.color} rx={2} />;
  return <g className="remote-flow-node">
    {activate ? <g role="button" tabIndex={0} aria-label={node.kind === "expense_group" ? `Focus ${node.label}` : `Open ${node.label} transactions`} onClick={activate} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }}>{rect}</g> : rect}
    <text x={labelX} y={y + Math.max(height, 12) / 2 - 2}><tspan>{node.label}</tspan><tspan x={labelX} dy="1.2em">{formatMoney(node.amount_minor)}</tspan></text>
  </g>;
}

function selectionFor(category: Pick<FlowCategory, "categoryId" | "label" | "amount_minor" | "entry_ids">): FlowSelection {
  return { categoryId: category.categoryId, label: category.label, amountMinor: category.amount_minor, entryIds: category.entry_ids };
}
