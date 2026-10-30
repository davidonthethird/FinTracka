import { useMemo, useState } from "react";
import { formatMoney } from "../format";
import { CategoryDrawer } from "./CategoryDrawer";
import { snapshotMonths, type RemoteSnapshot } from "./model";

type PlanningCategory = {
  category_id: string; category: string; historical_average_minor: number;
  target_minor: number; actual_minor: number; remaining_minor: number; status: string;
  percent_used_basis_points: number | null; subcategories: { subcategory: string; actual_minor: number }[];
  trend: { month: string; amount_minor: number }[]; transaction_ids: string[];
};
type Planning = {
  month: string; target_total_minor: number; actual_total_minor: number; remaining_total_minor: number;
  planned_income_total_minor: number; surplus_shortfall_minor: number; categories: PlanningCategory[];
};

export function PlanningPage({ snapshot }: { snapshot: RemoteSnapshot }) {
  const month = snapshotMonths(snapshot)[0];
  const [window, setWindow] = useState(6);
  const [owner, setOwner] = useState("Combined");
  const [selected, setSelected] = useState<PlanningCategory>();
  const planning = snapshot.planning[`${month}|window=${window}|owner=${owner}`] as unknown as Planning | undefined;
  const categories = planning?.categories.filter((item) => item.target_minor !== 0 || item.actual_minor !== 0) ?? [];
  const transactionMap = useMemo(() => new Map(snapshot.transactions.map((item) => [item.id, item])), [snapshot]);
  if (!planning) return <PageEmpty title="Planning is not available in this snapshot" />;
  return <div className="viewer-page">
    <header className="viewer-heading"><div><span>Goal versus actual</span><h1>Planning</h1></div><strong>{month}</strong></header>
    <section className="view-controls"><label>Average window<select value={window} onChange={(event) => setWindow(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} month{index ? "s" : ""}</option>)}</select></label><OwnerTabs value={owner} onChange={setOwner} /></section>
    <section className="plan-summary">
      <Summary label="Monthly target" value={planning.target_total_minor} />
      <Summary label="Spent so far" value={planning.actual_total_minor} tone="negative" />
      <Summary label="Remaining" value={planning.remaining_total_minor} tone={planning.remaining_total_minor >= 0 ? "positive" : "negative"} />
      <Summary label="Income after targets" value={planning.surplus_shortfall_minor} tone={planning.surplus_shortfall_minor > 0 ? "positive" : "negative"} />
    </section>
    <div className="category-ledger">{categories.map((category) => {
      const maximum = Math.max(category.historical_average_minor, category.target_minor, category.actual_minor, 1);
      return <button key={category.category_id} className="category-plan" onClick={() => setSelected(category)}>
        <div className="category-plan-heading"><span><strong>{category.category}</strong><small className={`status-text ${category.status}`}>{category.status.replaceAll("_", " ")}</small></span><b className={category.actual_minor > category.target_minor && category.target_minor > 0 ? "negative" : ""}>{formatMoney(category.actual_minor)}</b></div>
        <div className="comparison-bars" aria-label={`${category.category} average target and actual`}>
          <PlanBar label="Historical average" amount={category.historical_average_minor} maximum={maximum} kind="average" />
          <PlanBar label="Monthly target" amount={category.target_minor} maximum={maximum} kind="target" />
          <PlanBar label="Spent so far" amount={category.actual_minor} maximum={maximum} kind="actual" />
        </div>
        <div className="category-remaining"><span>{category.percent_used_basis_points === null ? "No target" : `${(category.percent_used_basis_points / 100).toFixed(0)}% used`}</span><strong className={category.remaining_minor >= 0 ? "positive" : "negative"}>{formatMoney(category.remaining_minor)} {category.remaining_minor >= 0 ? "left" : "over"}</strong></div>
      </button>;
    })}</div>
    {selected && <CategoryDrawer title={selected.category} subtitle={`${window}-month planning view`} metrics={[
      { label: "Historical average", value: selected.historical_average_minor },
      { label: "Monthly target", value: selected.target_minor },
      { label: "Spent so far", value: selected.actual_minor, tone: "negative" },
      { label: "Remaining", value: selected.remaining_minor, tone: selected.remaining_minor >= 0 ? "positive" : "negative" },
    ]} breakdown={selected.subcategories.map((item) => ({ label: item.subcategory, amount_minor: item.actual_minor }))} trend={selected.trend} transactions={selected.transaction_ids.map((id) => transactionMap.get(id)).filter((item) => item !== undefined)} onClose={() => setSelected(undefined)} />}
  </div>;
}

function OwnerTabs({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <div className="owner-tabs" aria-label="Spending owner">{["Combined", "David", "Ariela", "Shared"].map((owner) => <button key={owner} className={value === owner ? "active" : ""} onClick={() => onChange(owner)}>{owner}</button>)}</div>; }
function Summary({ label, value, tone = "" }: { label: string; value: number; tone?: string }) { return <div><span>{label}</span><strong className={tone}>{formatMoney(value)}</strong></div>; }
function PlanBar({ label, amount, maximum, kind }: { label: string; amount: number; maximum: number; kind: string }) { return <div className="plan-bar"><span>{label}</span><i><b className={kind} style={{ width: `${Math.max(amount > 0 ? 2 : 0, amount / maximum * 100)}%` }} /></i><strong>{formatMoney(amount)}</strong></div>; }
function PageEmpty({ title }: { title: string }) { return <div className="viewer-empty"><h2>{title}</h2></div>; }
