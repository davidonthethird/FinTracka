import { X } from "lucide-react";
import { formatMoney } from "../format";

export type SavingsGoal = {
  goal_id: string; name: string; pool: string; owner: string; balance_minor: number;
  monthly_target_minor: number; monthly_saved_minor: number; monthly_funded_basis_points: number | null;
  overall_target_minor: number | null; overall_remaining_minor: number | null;
  months: { month: string; additions_minor: number; spending_draw_minor: number; closing_minor: number }[];
};

export function SavingsGoalDrawer({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  return <div className="viewer-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="viewer-drawer" role="dialog" aria-modal="true" aria-labelledby="goal-title">
    <button className="drawer-close" aria-label="Close savings goal" onClick={onClose}><X /></button><span className="drawer-date">{goal.pool} · {goal.owner}</span><h2 id="goal-title">{goal.name}</h2><strong className="drawer-amount positive">{formatMoney(goal.balance_minor)}</strong>
    <div className="drawer-metrics"><div><span>Monthly goal</span><strong>{formatMoney(goal.monthly_target_minor)}</strong></div><div><span>Saved this month</span><strong>{formatMoney(goal.monthly_saved_minor)}</strong></div>{goal.overall_target_minor !== null && <><div><span>Overall goal</span><strong>{formatMoney(goal.overall_target_minor)}</strong></div><div><span>Still needed</span><strong>{formatMoney(goal.overall_remaining_minor ?? 0)}</strong></div></>}</div>
    <section className="drawer-section"><h3>Month-to-month savings</h3><div className="drawer-breakdown">{goal.months.map((month) => <div key={month.month}><span>{month.month}</span><strong>{formatMoney(month.closing_minor)}</strong></div>)}</div></section>
  </aside></div>;
}
