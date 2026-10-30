import { X } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "../format";
import { SavingsIcon } from "./icons";
import type { SavingsGoal } from "./model";

export function GoalDrawer({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const funded = Math.max(0, Math.min(goal.overall_funded_basis_points ?? goal.monthly_funded_basis_points ?? 0, 10_000));
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="goal-drawer" aria-label={`${goal.name} savings details`}>
      <header><span className={`goal-icon goal-${goal.color_key}`}><SavingsIcon name={goal.icon_key} /></span><div><h2>{goal.name}</h2><p>{goal.owner} · {goal.pool === "regular" ? "Regular savings" : "Retirement"}</p></div><button className="icon-button" aria-label="Close goal details" onClick={onClose}><X /></button></header>
      <div className="goal-drawer-metrics"><div><small>Total saved</small><strong>{formatMoney(goal.balance_minor)}</strong></div><div><small>Monthly goal</small><strong>{formatMoney(goal.monthly_target_minor)}</strong></div><div><small>Saved this month</small><strong>{formatMoney(goal.monthly_saved_minor)}</strong></div><div><small>Overall goal</small><strong>{goal.overall_target_minor ? formatMoney(goal.overall_target_minor) : "No limit"}</strong></div></div>
      <div className="goal-focus"><div className={`goal-focus-donut goal-${goal.color_key}`} style={{ background: `conic-gradient(currentColor ${funded / 100}%, color-mix(in srgb, currentColor 18%, transparent) 0)` }}><span>{goal.overall_target_minor ? `${Math.round((goal.overall_funded_basis_points ?? 0) / 100)}%` : goal.monthly_target_minor ? `${Math.round((goal.monthly_funded_basis_points ?? 0) / 100)}%` : "—"}</span></div><p>{goal.overall_target_minor ? <><strong>{formatMoney(goal.balance_minor)}</strong> saved toward the {formatMoney(goal.overall_target_minor)} overall goal. {formatMoney(goal.overall_remaining_minor ?? 0)} remains.</> : <><strong>{formatMoney(goal.monthly_saved_minor)}</strong> of {formatMoney(goal.monthly_target_minor)} saved this month. This goal has no overall limit.</>}</p></div>
      <h3>Month-to-month savings</h3>
      <div className="goal-history-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={goal.months}><XAxis dataKey="month"/><YAxis hide/><Tooltip formatter={(value) => formatMoney(Number(value))}/><Area dataKey="closing_minor" stroke="var(--teal)" fill="var(--teal-soft)"/></AreaChart></ResponsiveContainer></div>
      <div className="goal-month-list">{goal.months.slice().reverse().map((point) => <div key={point.month}><strong>{point.month}</strong><span>Added {formatMoney(point.additions_minor)}</span><span>Spent {formatMoney(point.spending_draw_minor + point.withdrawals_minor)}</span><b>{formatMoney(point.closing_minor)}</b></div>)}</div>
    </aside>
  </div>;
}
