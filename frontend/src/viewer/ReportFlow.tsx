import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Sankey } from "recharts";
import type { SankeyNodeProps } from "recharts";
import { formatMoney } from "../format";

export type FlowNode = { id: string; label: string; kind: string; amount_minor: number; entry_ids: string[] };
export type FlowLink = { source: number; target: number; amount_minor: number; entry_ids: string[] };
export type FlowGraph = { nodes: FlowNode[]; links: FlowLink[] };

export type FlowCategory = FlowNode & { categoryId: string | null; groupId: string; color: string };
export type FlowGroup = FlowNode & { color: string; categories: FlowCategory[] };

const colors = ["#e97745", "#53a86f", "#d45d8d", "#4f8edc", "#8c65c8", "#d9a62e", "#147d70"];

export function buildFlowGroups(report?: FlowGraph): FlowGroup[] {
  if (!report?.nodes || !report.links) return [];
  const groups = report.nodes.flatMap((node, index) => node.kind === "expense_group" ? [{ node, index }] : []);
  return groups.map(({ node, index }, groupIndex) => ({
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
  }));
}

export function ReportFlow({ report, onCategory }: {
  report?: FlowGraph;
  onCategory: (categoryId: string | null, label: string) => void;
}) {
  const groups = useMemo(() => buildFlowGroups(report), [report]);
  const [focusedGroupId, setFocusedGroupId] = useState<string>();
  const focusedGroup = groups.find((group) => group.id === focusedGroupId);
  const visibleGroups = focusedGroup ? [focusedGroup] : groups;
  const categories = visibleGroups.flatMap((group) => group.categories);
  const total = groups.reduce((sum, group) => sum + group.amount_minor, 0);
  const visibleTotal = visibleGroups.reduce((sum, group) => sum + group.amount_minor, 0);

  if (!groups.length || !report) return <div className="flow-unavailable"><strong>Detailed flow is not available</strong><span>The category totals below still show this month’s spending.</span></div>;

  return <div className="report-flow-map" aria-label="Zoomable financial flow">
    <div className="flow-zoom-bar">
      <span>{focusedGroup ? <><button onClick={() => setFocusedGroupId(undefined)}>All spending</button><b aria-hidden="true">›</b><strong>{focusedGroup.label}</strong></> : <strong>All spending</strong>}</span>
      {focusedGroup && <button className="flow-reset" onClick={() => setFocusedGroupId(undefined)}>Reset view</button>}
    </div>
    <div className="flow-sankey" aria-label="Connected income and spending flow">
      <DesktopFlow report={report} groups={groups} focusedGroup={focusedGroup} onFocus={setFocusedGroupId} onCategory={onCategory} />
    </div>
    <div className="flow-wheel-panel">
      <div className="flow-wheel">
        <PieChart width={300} height={300} style={{ width: "100%", height: "auto" }}>
          <Pie data={visibleGroups} dataKey="amount_minor" nameKey="label" innerRadius="34%" outerRadius="54%" paddingAngle={1} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
            {visibleGroups.map((group) => <Cell key={group.id} fill={group.color} cursor="pointer" onClick={() => setFocusedGroupId(group.id)} />)}
          </Pie>
          <Pie data={categories} dataKey="amount_minor" nameKey="label" innerRadius="58%" outerRadius="82%" paddingAngle={1} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
            {categories.map((category, index) => <Cell key={category.id} fill={category.color} fillOpacity={0.62 + (index % 3) * 0.12} cursor="pointer" onClick={() => onCategory(category.categoryId, category.label)} />)}
          </Pie>
        </PieChart>
        <span className="flow-wheel-total"><small>{focusedGroup ? focusedGroup.label : "Outflow"}</small><strong>{formatMoney(visibleTotal)}</strong></span>
      </div>
      <p>Tap a group to zoom in. Tap an outer category for its transactions.</p>
    </div>
    <div className="flow-group-list" aria-label="Spending groups">
      {groups.map((group) => <button key={group.id} className={focusedGroupId === group.id ? "active" : ""} aria-label={`Focus ${group.label}`} onClick={() => setFocusedGroupId(group.id)}>
        <i style={{ background: group.color }} />
        <span><strong>{group.label}</strong><small>{percentage(group.amount_minor, total)}% of spending</small></span>
        <b>{formatMoney(group.amount_minor)}</b>
      </button>)}
    </div>
    <div className="flow-category-list" aria-label={focusedGroup ? `${focusedGroup.label} categories` : "All spending categories"}>
      {categories.map((category) => <button key={category.id} onClick={() => onCategory(category.categoryId, category.label)}>
        <i style={{ background: category.color }} />
        <span><strong>{category.label}</strong><small>{percentage(category.amount_minor, total)}% of spending</small></span>
        <b>{formatMoney(category.amount_minor)}</b>
      </button>)}
    </div>
  </div>;
}

function DesktopFlow({ report, groups, focusedGroup, onFocus, onCategory }: {
  report: FlowGraph;
  groups: FlowGroup[];
  focusedGroup?: FlowGroup;
  onFocus: (id: string) => void;
  onCategory: (categoryId: string | null, label: string) => void;
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
  const columnCount = Math.max(groups.length, ...groups.map((group) => group.categories.length), 1);
  return <div style={{ height: Math.max(390, columnCount * 48) }}>
    <ResponsiveContainer width="100%" height="100%">
      <Sankey data={{ nodes, links }} iterations={0} sort={false} verticalAlign="top" nodePadding={24} nodeWidth={9} linkCurvature={0.42} margin={{ top: 18, right: 165, bottom: 18, left: 115 }} node={(props) => <FlowNodeShape {...props} onGroupFocus={onFocus} onCategory={onCategory} />} />
    </ResponsiveContainer>
  </div>;
}

function FlowNodeShape({ payload, x, y, width, height, onGroupFocus, onCategory }: SankeyNodeProps & {
  onGroupFocus: (id: string) => void;
  onCategory: (categoryId: string | null, label: string) => void;
}) {
  const node = payload as typeof payload & FlowNode & { color: string };
  const activate = node.kind === "expense_group"
    ? () => onGroupFocus(node.id)
    : node.kind === "expense"
      ? () => onCategory(node.id.slice("expense:".length) === "uncategorized-expense" ? null : node.id.slice("expense:".length), node.label)
      : undefined;
  const labelX = x + width + 7;
  const rect = <rect x={x} y={y} width={Math.max(width, 11)} height={Math.max(height, 7)} fill={node.color} rx={2} />;
  return <g className="remote-flow-node">
    {activate ? <g role="button" tabIndex={0} aria-label={node.kind === "expense_group" ? `Focus ${node.label}` : `Open ${node.label} transactions`} onClick={activate} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }}>{rect}</g> : rect}
    <text x={labelX} y={y + Math.max(height, 12) / 2 - 2}><tspan>{node.label}</tspan><tspan x={labelX} dy="1.2em">{formatMoney(node.amount_minor)}</tspan></text>
  </g>;
}

function percentage(amount: number, total: number): string { return total ? (amount / total * 100).toFixed(1) : "0.0"; }
