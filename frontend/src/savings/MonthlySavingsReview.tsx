import { api } from "../api";
import { formatMoney } from "../format";

type Review = { month: string; target_spending_minor: number; actual_spending_minor: number; cash_surplus_minor: number; suggested_minor: number; matched_minor: number; status: string; updated_at: string };

export function MonthlySavingsReview({ month, review, onSaved }: { month: string; review: Record<string, unknown> | null; onSaved: () => void }) {
  const value = review as Review | null;
  async function generate() { await api(`/savings/reviews/${month}/generate`, { method: "POST", body: "{}" }); onSaved(); }
  async function act(action: "accept" | "ignore") { if (!value) return; await api(`/savings/reviews/${month}/${action}`, { method: "POST", body: JSON.stringify({ expected_updated_at: value.updated_at }) }); onSaved(); }
  if (!value) return <section className="instrument-panel monthly-review"><div><p className="eyebrow">Monthly review</p><h2>Check for savings left from your plan</h2><p>This checks actual spending against targets. It will not claim money was saved unless matching savings money exists.</p></div><button onClick={generate}>Review {month}</button></section>;
  return <section className="instrument-panel monthly-review"><div className="section-heading"><div><p className="eyebrow">Monthly review · {value.month}</p><h2>{value.status === "waiting" ? "Waiting for matching savings" : value.status === "added" ? "Added to savings" : value.status === "ignored" ? "Ignored" : `${formatMoney(value.suggested_minor)} available`}</h2></div><span>{value.status}</span></div><div className="review-metrics"><span>Target spending <b>{formatMoney(value.target_spending_minor)}</b></span><span>Actual spending <b>{formatMoney(value.actual_spending_minor)}</b></span><span>Cash available <b>{formatMoney(value.cash_surplus_minor)}</b></span><span>Suggested <b>{formatMoney(value.suggested_minor)}</b></span></div>{value.status === "pending" && <div className="review-actions"><button className="primary" onClick={() => act("accept")}>Add {formatMoney(value.suggested_minor)}</button><button onClick={() => act("ignore")}>Ignore this month</button></div>}</section>;
}
