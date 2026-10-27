import type { CSSProperties } from "react";

import { formatMoney } from "../format";
import { actualCategoryStatus, flowScale, laneWeight, percentLabel, remainingLabel, type PlanningCategory, type PlanningIncome, type PlanningSnapshot, type SpendingOwner } from "./model";

export function PlanningFlow({
  incomes,
  categories,
  total,
  onCategory,
  ownerSnapshots,
}: {
  incomes: PlanningIncome[];
  categories: PlanningCategory[];
  total: number;
  onCategory: (category: PlanningCategory, trigger: HTMLElement, owner?: SpendingOwner) => void;
  ownerSnapshots?: Partial<Record<SpendingOwner, PlanningSnapshot>>;
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
        const weight = laneWeight(category, categories);
        const status = actualCategoryStatus(category);
        const style = {
          "--lane-weight": weight,
          minHeight: `${52 + Math.round(weight * 160)}px`,
        } as CSSProperties;
        const ownerRows = ownerSnapshots && (["David", "Ariela", "Shared"] as SpendingOwner[]).map((owner) => ({
          owner,
          category: ownerSnapshots[owner]?.categories.find((row) => row.category_id === category.category_id),
        }));
        return <div role="button" tabIndex={0} className={`planning-category ${status}`} style={style} data-status={status} key={category.category_id} onClick={(event) => onCategory(category, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onCategory(category, event.currentTarget); } }}>
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
          <b>{category.target_minor ? `${formatMoney(Math.abs(category.remaining_minor))} ${category.remaining_minor < 0 ? "over" : "left"}` : category.actual_minor > 0 ? `${formatMoney(category.actual_minor)} unplanned` : "No target"}<small>{percentLabel(category)}</small></b>
          {ownerRows && <span className="owner-lanes" aria-label={`${category.category} spending by person`}>{ownerRows.map(({ owner, category: personCategory }) => { const amount = personCategory?.actual_minor || 0; const totalActual = Math.max(category.actual_minor, 1); return <button type="button" className={`owner-lane owner-${owner.toLowerCase()}`} style={{ flexGrow: Math.max(amount / totalActual, 0.08) }} key={owner} onClick={(event) => { event.stopPropagation(); onCategory(personCategory || category, event.currentTarget, owner); }}><strong>{owner}</strong><small>{formatMoney(amount)}</small></button>; })}</span>}
          <span className="sr-only">{remainingLabel(category)}</span>
        </div>;
      })}
    </section>
  </div>;
}
