import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney, minorToMajorInput } from "../format";
import { redistributeTargets, type AllocationRow } from "./allocation";
import type { SavingsGoalOverview } from "./model";

type Props = { overview: SavingsGoalOverview; month: string; onSaved: () => void };

export function AllocationRules({ overview, month, onSaved }: Props) {
  const [pool, setPool] = useState<"regular" | "retirement">("regular");
  const leaves = overview.goals.filter((goal) => goal.pool === pool && goal.active && !overview.goals.some((child) => child.parent_id === goal.goal_id && child.active));
  const [rows, setRows] = useState<AllocationRow[]>(() => leaves.map((goal) => ({ goal_id: goal.goal_id, monthly_target_minor: goal.monthly_target_minor, locked: goal.locked, priority: goal.priority })));
  const [error, setError] = useState("");
  const total = rows.reduce((sum, row) => sum + row.monthly_target_minor, 0);
  const names = Object.fromEntries(overview.goals.map((goal) => [goal.goal_id, goal.name]));
  useEffect(() => setRows(leaves.map((goal) => ({ goal_id: goal.goal_id, monthly_target_minor: goal.monthly_target_minor, locked: goal.locked, priority: goal.priority }))), [overview, pool]);

  async function save() {
    try {
      await api(`/savings/allocation-plans/${pool}`, { method: "PUT", body: JSON.stringify({ expected_updated_at: overview.plan_updated_at, effective_month: month, rows }) });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save allocation"); }
  }

  return <section className="instrument-panel allocation-rules">
    <div className="section-heading"><div><p className="eyebrow">Allocation rules</p><h2>Split future savings</h2></div><label>Pool<select value={pool} onChange={(event) => setPool(event.target.value as "regular" | "retirement")}><option value="regular">Regular savings</option><option value="retirement">Retirement</option></select></label><span>{formatMoney(total)} planned each month</span></div>
    <div className="allocation-actions"><button onClick={() => setRows(rows.map((row) => ({ ...row, locked: true })))}>Lock all</button><button onClick={() => setRows(rows.map((row) => ({ ...row, locked: false })))}>Unlock all</button></div>
    {!rows.length && <p className="empty">Add an active {pool === "regular" ? "regular savings" : "retirement"} goal before setting its allocation.</p>}
    {rows.map((row, index) => { const basis = total ? Math.round(row.monthly_target_minor * 10_000 / total) : 0; return <div className="allocation-row" key={row.goal_id}>
      <span><b>{index + 1}</b><strong>{names[row.goal_id]}</strong></span>
      <input aria-label={`${names[row.goal_id]} allocation`} type="range" min="0" max="10000" value={basis} onChange={(event) => setRows(redistributeTargets(rows, row.goal_id, Number(event.target.value)))} />
      <output>{(basis / 100).toFixed(1)}%</output>
      <input aria-label={`${names[row.goal_id]} monthly dollars`} inputMode="decimal" value={minorToMajorInput(row.monthly_target_minor, "USD")} onChange={(event) => setRows(rows.map((item) => item.goal_id === row.goal_id ? { ...item, monthly_target_minor: Math.max(0, Math.round(Number(event.target.value || 0) * 100)) } : item))} />
      <button aria-label={`${row.locked ? "Unlock" : "Lock"} ${names[row.goal_id]}`} title={row.locked ? "Unlock" : "Lock"} onClick={() => setRows(rows.map((item) => item.goal_id === row.goal_id ? { ...item, locked: !item.locked } : item))}>{row.locked ? "🔒" : "🔓"}</button>
      <span className="move-controls"><button aria-label={`Move ${names[row.goal_id]} up`} disabled={index === 0} onClick={() => setRows(move(rows, index, -1))}>↑</button><button aria-label={`Move ${names[row.goal_id]} down`} disabled={index === rows.length - 1} onClick={() => setRows(move(rows, index, 1))}>↓</button></span>
    </div>; })}
    {error && <p className="form-error">{error}</p>}<button className="primary" disabled={!rows.length} onClick={save}>Save allocation plan</button>
  </section>;
}

function move(rows: AllocationRow[], index: number, direction: number) {
  const copy = [...rows];
  [copy[index], copy[index + direction]] = [copy[index + direction], copy[index]];
  return copy.map((row, priority) => ({ ...row, priority: priority + 1 }));
}
