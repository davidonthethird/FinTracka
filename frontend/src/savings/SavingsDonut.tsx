import { formatMoney } from "../format";
import { buildSavingsArcs, type SavingsGoal, type SavingsGoalViewMode } from "./model";

export function SavingsDonut({ goals, mode, onSelect }: { goals: SavingsGoal[]; mode: SavingsGoalViewMode; onSelect: (goal: SavingsGoal) => void }) {
  const arcs = buildSavingsArcs(goals, mode);
  const total = mode === "monthly"
    ? arcs.reduce((sum, arc) => sum + arc.goal.monthly_target_minor, 0)
    : arcs.reduce((sum, arc) => sum + arc.goal.balance_minor, 0);
  const saved = arcs.reduce((sum, arc) => sum + arc.goal.monthly_saved_minor, 0);
  let offset = 0;
  return <div className="savings-donut-wrap">
    <svg className="savings-donut" viewBox="0 0 120 120" role="img" aria-label={`Savings goals totaling ${formatMoney(total)}`}>
      <circle className="donut-track" cx="60" cy="60" r="45" pathLength="100" />
      {arcs.flatMap((arc) => {
        const length = arc.allocationBasisPoints / 100;
        const start = offset; offset += length;
        const progress = length * arc.fundedBasisPoints / 10_000;
        return [
          <circle key={`${arc.goal.goal_id}-plan`} className={`donut-arc goal-${arc.goal.color_key} planned`} cx="60" cy="60" r="45" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} />,
          <circle key={`${arc.goal.goal_id}-funded`} className={`donut-arc goal-${arc.goal.color_key} funded`} cx="60" cy="60" r="45" pathLength="100" strokeDasharray={`${progress} ${100 - progress}`} strokeDashoffset={-start} />,
        ];
      })}
    </svg>
    <div className="donut-center"><small>{mode === "monthly" ? "Saved this month" : "Total savings"}</small><strong>{formatMoney(mode === "monthly" ? saved : total)}</strong>{mode === "monthly" && <small>of {formatMoney(total)}</small>}</div>
    <div className="savings-goal-legend">{arcs.map((arc) => <button key={arc.goal.goal_id} onClick={() => onSelect(arc.goal)}><span className={`goal-swatch goal-${arc.goal.color_key}`} /><span><strong>{arc.goal.name}</strong><small>{mode === "monthly" ? `${formatMoney(arc.goal.monthly_saved_minor)} of ${formatMoney(arc.goal.monthly_target_minor)}` : arc.goal.overall_target_minor ? `${formatMoney(arc.goal.balance_minor)} of ${formatMoney(arc.goal.overall_target_minor)}` : `${formatMoney(arc.goal.balance_minor)} · no overall limit`} · {(arc.allocationBasisPoints / 100).toFixed(1)}%</small></span></button>)}</div>
  </div>;
}
