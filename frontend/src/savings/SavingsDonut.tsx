import { formatMoney } from "../format";
import { buildSavingsArcs, type SavingsGoal } from "./model";

export function SavingsDonut({ goals, total, onSelect }: { goals: SavingsGoal[]; total: number; onSelect: (goal: SavingsGoal) => void }) {
  const arcs = buildSavingsArcs(goals);
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
    <div className="donut-center"><small>Total savings</small><strong>{formatMoney(total)}</strong></div>
    <div className="savings-goal-legend">{arcs.map((arc) => <button key={arc.goal.goal_id} onClick={() => onSelect(arc.goal)}><span className={`goal-swatch goal-${arc.goal.color_key}`} /><span><strong>{arc.goal.name}</strong><small>{formatMoney(arc.goal.balance_minor)} · {(arc.allocationBasisPoints / 100).toFixed(1)}%</small></span></button>)}</div>
  </div>;
}
