import { X } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "../format";
import { SavingsIcon } from "./icons";
import type { SavingsGoal } from "./model";

export function GoalDrawer({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="goal-drawer" aria-label={`${goal.name} savings details`}>
      <header><span className={`goal-icon goal-${goal.color_key}`}><SavingsIcon name={goal.icon_key} /></span><div><h2>{goal.name}</h2><p>{goal.owner} · {goal.pool === "regular" ? "Regular savings" : "Retirement"}</p></div><button className="icon-button" aria-label="Close goal details" onClick={onClose}><X /></button></header>
      <div className="goal-drawer-metrics"><div><small>Balance</small><strong>{formatMoney(goal.balance_minor)}</strong></div><div><small>Monthly goal</small><strong>{formatMoney(goal.monthly_target_minor)}</strong></div><div><small>Expected to date</small><strong>{formatMoney(goal.expected_to_date_minor)}</strong></div><div><small>Progress</small><strong>{goal.funded_basis_points === null ? "No target" : `${(goal.funded_basis_points / 100).toFixed(0)}%`}</strong></div></div>
      <h3>Month-to-month savings</h3>
      <div className="goal-history-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={goal.months}><XAxis dataKey="month"/><YAxis hide/><Tooltip formatter={(value) => formatMoney(Number(value))}/><Area dataKey="closing_minor" stroke="var(--teal)" fill="var(--teal-soft)"/></AreaChart></ResponsiveContainer></div>
      <div className="goal-month-list">{goal.months.slice().reverse().map((point) => <div key={point.month}><strong>{point.month}</strong><span>Added {formatMoney(point.additions_minor)}</span><span>Spent {formatMoney(point.spending_draw_minor + point.withdrawals_minor)}</span><b>{formatMoney(point.closing_minor)}</b></div>)}</div>
    </aside>
  </div>;
}
