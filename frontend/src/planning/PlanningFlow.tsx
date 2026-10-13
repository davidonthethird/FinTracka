import { formatMoney } from "../format";
import { flowScale, remainingLabel, type PlanningCategory, type PlanningIncome } from "./model";

export function PlanningFlow({
  incomes,
  categories,
  total,
  onCategory,
}: {
  incomes: PlanningIncome[];
  categories: PlanningCategory[];
  total: number;
  onCategory: (category: PlanningCategory, trigger: HTMLButtonElement) => void;
}) {
  return <div className="planning-flow">
    <section className="planning-incomes" aria-label="Planned income sources">
      <h2>Income sources</h2>
      {incomes.length ? incomes.map((income) => <div className="income-chip" key={income.source_id}>
        <span>{income.title}<small>{income.income_type}</small></span><strong>{formatMoney(income.amount_minor)}</strong>
      </div>) : <p className="muted">Add Salary or custom monthly income.</p>}
    </section>
    <div className="plan-hub"><span>Monthly plan</span><strong>{formatMoney(total)}</strong><small>Total planned income</small></div>
    <section className="planning-categories" aria-label="Category plans">
      {categories.map((category) => {
        const scale = flowScale(category);
        return <button className={`planning-category ${category.status}`} key={category.category_id} onClick={(event) => onCategory(category, event.currentTarget)}>
          <span className="planning-category-name"><strong>{category.category}</strong>{category.tzedaka_minimum_minor > 0 && <small>10% Salary minimum</small>}</span>
          <span className="planning-bars" aria-hidden="true">
            <i className="average" style={{ width: `${scale.average * 100}%` }} />
            <i className="target" style={{ width: `${scale.target * 100}%` }} />
            <i className="actual" style={{ width: `${scale.actual * 100}%` }} />
          </span>
          <span className="planning-values">
            <small>Avg {formatMoney(category.historical_average_minor)}</small>
            <small>Target {formatMoney(category.target_minor)}</small>
            <small>Spent {formatMoney(category.actual_minor)}</small>
          </span>
          <b>{formatMoney(Math.abs(category.remaining_minor))} {category.remaining_minor < 0 ? "over" : "left"}</b>
          <span className="sr-only">{remainingLabel(category)}</span>
        </button>;
      })}
    </section>
  </div>;
}
