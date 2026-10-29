import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Search, ZoomIn, ZoomOut } from "lucide-react";

import { formatMoney } from "../format";
import type { FlowOwner } from "../reports/flow";
import type { FlowGraph, FlowGroup, FlowSelection } from "./ReportFlow";
import {
  buildMobileFlowModel,
  layoutMobileFlow,
  type MobileFlowCategory,
  type MobileFlowItem,
  type MobileFlowOwner,
  type MobileFlowSubcategory,
} from "./mobileFlowLayout";

export interface MobileExpandableSankeyProps {
  report: FlowGraph;
  groups: FlowGroup[];
  onSelect: (selection: FlowSelection) => void;
}

export function MobileExpandableSankey({ report, groups, onSelect }: MobileExpandableSankeyProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(343);
  const [expandedSource, setExpandedSource] = useState(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState<MobileFlowOwner>("Everyone");
  const [splitByOwner, setSplitByOwner] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();

  const model = useMemo(() => buildMobileFlowModel(report, groups, owner), [report, groups, owner]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => resetSessionView(), [report]);

  const searchExpansion = useMemo(() => {
    const groupIds = new Set<string>();
    const categoryIds = new Set<string>();
    let source = false;
    if (!model || !query.trim()) return { groupIds, categoryIds, source };
    const wanted = query.trim().toLocaleLowerCase();
    source = model.sources.some((item) => matches(item, wanted));
    model.groups.forEach((group) => {
      const matchingGroup = matches(group, wanted);
      if (matchingGroup) groupIds.add(group.id);
      group.children.forEach((category) => {
        const matchingCategory = matches(category, wanted);
        const matchingChild = category.children.some((child) => matches(child, wanted));
        if (matchingGroup || matchingCategory || matchingChild) groupIds.add(group.id);
        if (matchingCategory || matchingChild) categoryIds.add(category.id);
      });
    });
    return { groupIds, categoryIds, source };
  }, [model, query]);

  const effectiveGroupIds = union(expandedGroupIds, searchExpansion.groupIds);
  const effectiveCategoryIds = union(expandedCategoryIds, searchExpansion.categoryIds);
  const layout = useMemo(() => model ? layoutMobileFlow(model, {
    width,
    expandedSource: expandedSource || searchExpansion.source,
    expandedGroupIds: effectiveGroupIds,
    expandedCategoryIds: effectiveCategoryIds,
    splitByOwner,
  }) : null, [model, width, expandedSource, searchExpansion.source, effectiveGroupIds, effectiveCategoryIds, splitByOwner]);

  if (!model || !layout) return <div className="flow-unavailable"><strong>Detailed flow is not available</strong></div>;

  const allGroupIds = new Set(model.groups.map((group) => group.id));
  const allCategoryIds = new Set(model.groups.flatMap((group) => group.children.filter((category) => category.children.length).map((category) => category.id)));
  const nodeItems = new Map(layout.nodes.map((node) => [node.id, node.item]));

  function resetSessionView() {
    setExpandedSource(false);
    setExpandedGroupIds(new Set());
    setExpandedCategoryIds(new Set());
    setQuery("");
    setSelectedId(undefined);
  }

  function changeOwner(next: MobileFlowOwner) {
    setOwner(next);
    setExpandedSource(false);
    setExpandedGroupIds(new Set());
    setExpandedCategoryIds(new Set());
    setSelectedId(undefined);
  }

  function select(item: MobileFlowItem) {
    setSelectedId(item.id);
    if (item.kind === "subcategory" || item.kind === "category" || item.kind === "terminal") {
      const detail = isSubcategory(item) ? item : undefined;
      onSelect({
        categoryId: detail?.categoryId ?? (isCategory(item) ? item.categoryId : null),
        subcategoryId: detail?.subcategoryId,
        label: item.label,
        amountMinor: item.amountMinor,
        entryIds: item.entryIds,
        owner: owner === "Everyone" ? undefined : owner,
      });
    }
  }

  function activate(item: MobileFlowItem) {
    if (item.kind === "hub") return setExpandedSource((value) => !value);
    if (item.kind === "group") return setExpandedGroupIds((value) => toggle(value, item.id));
    if (isCategory(item) && item.children.length) {
      return setExpandedCategoryIds((value) => toggle(value, item.id));
    }
    select(item);
  }

  return <div className="mobile-flow" ref={hostRef}>
    <div className="mobile-flow-toolbar" aria-label="Financial flow view controls">
      <div className="mobile-flow-density" aria-label="Flow detail level">
        <button aria-pressed={!expandedGroupIds.size} onClick={() => { setExpandedSource(false); setExpandedGroupIds(new Set()); setExpandedCategoryIds(new Set()); }}>Compact</button>
        <button aria-pressed={expandedGroupIds.size === allGroupIds.size && !expandedCategoryIds.size} onClick={() => { setExpandedGroupIds(allGroupIds); setExpandedCategoryIds(new Set()); }}>Detailed</button>
      </div>
      <button onClick={() => { setExpandedSource(true); setExpandedGroupIds(allGroupIds); setExpandedCategoryIds(allCategoryIds); }}>Expand all</button>
      <button onClick={() => { setExpandedSource(false); setExpandedGroupIds(new Set()); setExpandedCategoryIds(new Set()); }}>Collapse all</button>
      <label className="mobile-flow-split"><input type="checkbox" checked={splitByOwner} onChange={(event) => setSplitByOwner(event.currentTarget.checked)} />Split spending by person</label>
      <div className="mobile-flow-owners" aria-label="Spending owner">
        {(["Everyone", "David", "Ariela", "Shared"] as MobileFlowOwner[]).map((name) => <button key={name} aria-pressed={owner === name} onClick={() => changeOwner(name)}>{name}</button>)}
      </div>
      <label className="mobile-flow-search"><Search aria-hidden="true" /><span className="sr-only">Search financial flow</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search financial flow" aria-label="Search financial flow" /></label>
      <div className="mobile-flow-viewport-controls">
        <button aria-label="Zoom in" title="Zoom in"><ZoomIn /></button>
        <button aria-label="Zoom out" title="Zoom out"><ZoomOut /></button>
        <button aria-label="Fit to screen">Fit to screen</button>
        <button aria-label="Reset view" onClick={resetSessionView}>Reset view</button>
        <button aria-label="Enter fullscreen" title="Enter fullscreen"><Maximize2 /></button>
      </div>
    </div>
    <div className="mobile-flow-stage" style={{ width: layout.width, height: layout.height }}>
      <svg className="mobile-flow-ribbons" width={layout.width} height={layout.height} aria-label="Connected financial flow ribbons">
        {layout.ribbons.map((ribbon) => {
          const faded = Boolean(selectedId && ribbon.sourceId !== selectedId && ribbon.targetId !== selectedId);
          const target = nodeItems.get(ribbon.targetId);
          return <path key={ribbon.id} d={ribbon.path} stroke={ribbon.color} strokeWidth={ribbon.width} className={faded ? "is-faded" : ""} fill="none" opacity=".45" role="button" tabIndex={0} aria-label={`Open ${target?.label ?? "flow"} details`} onClick={() => target && select(target)} onKeyDown={(event) => activateKey(event, () => target && select(target))} />;
        })}
      </svg>
      {layout.nodes.map((node) => {
        const item = node.item;
        const expandable = item.kind === "hub" || item.kind === "group" || (isCategory(item) && item.children.length > 0);
        const expanded = item.kind === "hub" ? expandedSource || searchExpansion.source : item.kind === "group" ? effectiveGroupIds.has(item.id) : effectiveCategoryIds.has(item.id);
        const faded = Boolean(selectedId && selectedId !== item.id && !layout.ribbons.some((ribbon) => (ribbon.sourceId === selectedId && ribbon.targetId === item.id) || (ribbon.targetId === selectedId && ribbon.sourceId === item.id)));
        return <button
          key={item.id}
          id={`mobile-flow-node-${safeId(item.id)}`}
          className={`mobile-flow-node mobile-flow-${item.kind}${selectedId === item.id ? " is-selected" : ""}${faded ? " is-faded" : ""}`}
          style={{ left: node.x, top: node.y, width: node.width, height: node.height, "--flow-color": item.color } as React.CSSProperties}
          title={`${item.label}: ${formatMoney(item.amountMinor)}`}
          aria-expanded={expandable ? expanded : undefined}
          aria-controls={expandable ? `mobile-flow-children-${safeId(item.id)}` : undefined}
          onClick={() => activate(item)}
        >
          <i aria-hidden="true" />
          <span><strong>{item.label}</strong><small>{formatMoney(item.amountMinor)}</small></span>
          {item.kind !== "hub" && <b>{(item.percentBasisPoints / 100).toFixed(1)}%</b>}
          {expandable && <em aria-hidden="true">{expanded ? "−" : "+"}</em>}
        </button>;
      })}
      {[...effectiveGroupIds, ...effectiveCategoryIds].map((id) => <span key={id} id={`mobile-flow-children-${safeId(id)}`} className="sr-only">Expanded children for {nodeItems.get(id)?.label}</span>)}
    </div>
    <div className="mobile-flow-owner-key" aria-label="Spending owner colors"><span className="david">David</span><span className="ariela">Ariela</span><span className="shared">Shared</span></div>
  </div>;
}

function toggle(values: Set<string>, id: string): Set<string> {
  const next = new Set(values);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function union(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function matches(item: MobileFlowItem, query: string): boolean {
  return item.label.toLocaleLowerCase().includes(query);
}

function isCategory(item: MobileFlowItem): item is MobileFlowCategory {
  return item.kind === "category";
}

function isSubcategory(item: MobileFlowItem): item is MobileFlowSubcategory {
  return item.kind === "subcategory";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function activateKey(event: React.KeyboardEvent, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}
