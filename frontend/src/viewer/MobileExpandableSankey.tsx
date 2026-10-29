import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Search, ZoomIn, ZoomOut } from "lucide-react";

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
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistance = useRef(0);
  const [width, setWidth] = useState(343);
  const [expandedSource, setExpandedSource] = useState(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState<MobileFlowOwner>("Everyone");
  const [splitByOwner, setSplitByOwner] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenFallback, setFullscreenFallback] = useState(false);

  const model = useMemo(() => buildMobileFlowModel(report, groups, owner), [report, groups, owner]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => resetSessionView(), [report]);

  useEffect(() => {
    const fullscreenChanged = () => setFullscreen(document.fullscreenElement === rootRef.current);
    const escapeFallback = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreenFallback(false);
    };
    document.addEventListener("fullscreenchange", fullscreenChanged);
    document.addEventListener("keydown", escapeFallback);
    return () => {
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      document.removeEventListener("keydown", escapeFallback);
    };
  }, []);

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

  const viewportHeight = layout ? (scale > 1 ? Math.min(layout.height, 620) : layout.height) : 0;

  useEffect(() => {
    if (!layout) return;
    setPan((value) => clampPan(value, scale, layout.width, layout.height, viewportHeight));
  }, [layout, scale, viewportHeight]);

  if (!model || !layout) return <div className="flow-unavailable"><strong>Detailed flow is not available</strong></div>;
  const currentLayout = layout;

  const allGroupIds = new Set(model.groups.map((group) => group.id));
  const allCategoryIds = new Set(model.groups.flatMap((group) => group.children.filter((category) => category.children.length).map((category) => category.id)));
  const nodeItems = new Map(layout.nodes.map((node) => [node.id, node.item]));
  const wanted = query.trim().toLocaleLowerCase();
  const ownerEmpty = owner !== "Everyone" && model.visibleSpendingMinor === 0;

  function resetSessionView() {
    setExpandedSource(false);
    setExpandedGroupIds(new Set());
    setExpandedCategoryIds(new Set());
    setQuery("");
    setSelectedId(undefined);
    setOwner("Everyone");
    setSplitByOwner(false);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  function changeOwner(next: MobileFlowOwner) {
    setOwner(next);
    setExpandedSource(false);
    setExpandedGroupIds(new Set());
    setExpandedCategoryIds(new Set());
    setSelectedId(undefined);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  function changeScale(delta: number) {
    setScale((value) => boundedScale(value + delta));
  }

  function fitView() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  async function toggleFullscreen() {
    if (fullscreenFallback) return setFullscreenFallback(false);
    if (document.fullscreenElement) return document.exitFullscreen();
    const root = rootRef.current;
    if (root?.requestFullscreen) {
      try {
        await root.requestFullscreen();
        return;
      } catch {
        // Browser policy may reject fullscreen; the fixed overlay keeps the control useful.
      }
    }
    setFullscreenFallback(true);
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (scale > 1 || pointers.current.size > 1) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic test pointers are not browser-active. */ }
    }
    if (pointers.current.size > 1) {
      event.preventDefault();
      pinchDistance.current = pointerDistance([...pointers.current.values()]);
    }
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size > 1) {
      event.preventDefault();
      const distance = pointerDistance([...pointers.current.values()]);
      const previousDistance = pinchDistance.current;
      if (previousDistance > 0) setScale((value) => boundedScale(value * distance / previousDistance));
      pinchDistance.current = distance;
    } else if (scale > 1) {
      event.preventDefault();
      setPan((value) => clampPan(
        { x: value.x + event.clientX - previous.x, y: value.y + event.clientY - previous.y },
        scale, currentLayout.width, currentLayout.height, viewportHeight,
      ));
    }
  }

  function pointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    pinchDistance.current = pointers.current.size > 1 ? pointerDistance([...pointers.current.values()]) : 0;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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

  return <div className={`mobile-flow${fullscreenFallback ? " mobile-flow-fullscreen-fallback" : ""}`} ref={(element) => { rootRef.current = element; hostRef.current = element; }}>
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
        <button aria-label="Zoom in" title="Zoom in" onClick={() => changeScale(.2)}><ZoomIn /></button>
        <button aria-label="Zoom out" title="Zoom out" onClick={() => changeScale(-.2)}><ZoomOut /></button>
        <button aria-label="Fit to screen" onClick={fitView}>Fit to screen</button>
        <button aria-label="Reset view" onClick={resetSessionView}>Reset view</button>
        <button aria-label={fullscreen || fullscreenFallback ? "Exit fullscreen" : "Enter fullscreen"} title={fullscreen || fullscreenFallback ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggleFullscreen}>{fullscreen || fullscreenFallback ? <Minimize2 /> : <Maximize2 />}</button>
      </div>
    </div>
    {ownerEmpty && <p className="mobile-flow-empty">No spending is assigned to {owner} for this month.</p>}
    <div
      ref={viewportRef}
      className={`mobile-flow-viewport${scale > 1 ? " is-zoomed" : ""}${ownerEmpty ? " is-owner-empty" : ""}`}
      data-scale={scale.toFixed(1)}
      data-pan-x={Math.round(pan.x)}
      data-pan-y={Math.round(pan.y)}
      style={{ height: viewportHeight }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
    >
    <div className="mobile-flow-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
      <svg className="mobile-flow-ribbons" width={layout.width} height={layout.height} aria-label="Connected financial flow ribbons">
        {layout.ribbons.map((ribbon) => {
          const faded = Boolean(selectedId && ribbon.sourceId !== selectedId && ribbon.targetId !== selectedId);
          const target = nodeItems.get(ribbon.targetId);
          const searchMatch = Boolean(wanted && target && matches(target, wanted));
          const ownerShare = ribbon.owner && target?.amountMinor
            ? ` ${ribbon.owner}, ${(ribbon.amountMinor / target.amountMinor * 100).toFixed(1)}%, ${formatMoney(ribbon.amountMinor)}.`
            : "";
          return <path key={ribbon.id} d={ribbon.path} stroke={ribbon.color} strokeWidth={ribbon.width} className={`${faded ? "is-faded" : ""}${searchMatch ? " is-search-match" : ""}`} fill="none" opacity=".45" role="button" tabIndex={0} aria-label={`Open ${target?.label ?? "flow"} details.${ownerShare}`} onClick={() => target && select(target)} onKeyDown={(event) => activateKey(event, () => target && select(target))} />;
        })}
      </svg>
      {layout.nodes.map((node) => {
        const item = node.item;
        const expandable = item.kind === "hub" || item.kind === "group" || (isCategory(item) && item.children.length > 0);
        const expanded = item.kind === "hub" ? expandedSource || searchExpansion.source : item.kind === "group" ? effectiveGroupIds.has(item.id) : effectiveCategoryIds.has(item.id);
        const faded = Boolean(selectedId && selectedId !== item.id && !layout.ribbons.some((ribbon) => (ribbon.sourceId === selectedId && ribbon.targetId === item.id) || (ribbon.targetId === selectedId && ribbon.sourceId === item.id)));
        const searchMatch = Boolean(wanted && matches(item, wanted));
        return <button
          key={item.id}
          id={`mobile-flow-node-${safeId(item.id)}`}
          className={`mobile-flow-node mobile-flow-${item.kind}${selectedId === item.id ? " is-selected" : ""}${faded ? " is-faded" : ""}${searchMatch ? " is-search-match" : ""}`}
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
          {splitByOwner && item.ownerBasisPoints && <span className="mobile-flow-node-owner-splits" aria-label={ownerShareLabel(item.ownerBasisPoints)}>
            {(["David", "Ariela", "Shared"] as FlowOwner[]).flatMap((name) => item.ownerBasisPoints?.[name] ? [<i key={name} className={name.toLowerCase()}>{name[0]} {(item.ownerBasisPoints[name]! / 100).toFixed(1)}%</i>] : [])}
          </span>}
        </button>;
      })}
      {layout.nodes.filter((node) => node.item.kind === "hub" || node.item.kind === "group" || isCategory(node.item)).map((node) => <span key={node.id} id={`mobile-flow-children-${safeId(node.id)}`} className="sr-only">Children for {node.item.label}</span>)}
    </div>
    </div>
    <div className="mobile-flow-owner-key" aria-label="Spending owner colors"><span className="david">David</span><span className="ariela">Ariela</span><span className="shared">Shared</span></div>
    {owner !== "Everyone" && <p className="mobile-flow-owner-summary">{owner}: {formatMoney(model.visibleSpendingMinor)} · {(model.householdSpendingMinor ? model.visibleSpendingMinor / model.householdSpendingMinor * 100 : 0).toFixed(1)}% of household spending</p>}
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

function ownerShareLabel(shares: Partial<Record<FlowOwner, number>>): string {
  return (["David", "Ariela", "Shared"] as FlowOwner[])
    .flatMap((name) => shares[name] ? [`${name} ${(shares[name]! / 100).toFixed(1)}%`] : [])
    .join(", ");
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function boundedScale(value: number): number {
  return Math.round(Math.max(.8, Math.min(2.4, value)) * 10) / 10;
}

function pointerDistance(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function clampPan(
  value: { x: number; y: number }, scale: number,
  stageWidth: number, stageHeight: number, viewportHeight: number,
): { x: number; y: number } {
  if (scale <= 1) return { x: 0, y: 0 };
  const minX = Math.min(0, stageWidth - stageWidth * scale);
  const minY = Math.min(0, viewportHeight - stageHeight * scale);
  return {
    x: Math.max(minX, Math.min(0, value.x)),
    y: Math.max(minY, Math.min(0, value.y)),
  };
}

function activateKey(event: React.KeyboardEvent, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}
