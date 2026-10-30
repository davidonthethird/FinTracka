import { formatMoney } from "../format";
import { freshnessLabel, snapshotMonths, type RemoteSnapshot } from "./model";

export function OverviewPage({ snapshot, publishedAt }: { snapshot: RemoteSnapshot; publishedAt?: string }) {
  const month = snapshotMonths(snapshot)[0];
  const overview = snapshot.overview[month];
  const recent = snapshot.transactions.slice(0, 6);
  if (!overview) return <Empty title="No overview is available" />;
  return <div className="viewer-page">
    <header className="viewer-heading"><div><span>Household position</span><h1>Overview</h1></div><strong>{monthLabel(month)}</strong></header>
    <section className="freshness-ribbon" aria-label="Data freshness">
      <Freshness label="Bank data" value={freshnessLabel(snapshot.source_last_sync_at)} />
      <Freshness label="Snapshot made" value={freshnessLabel(snapshot.captured_at)} />
      <Freshness label="Published" value={freshnessLabel(publishedAt ?? null)} />
    </section>
    <section className="balance-ledger">
      <div className="primary-balance"><span>Net position</span><strong>{formatMoney(overview.net_position_minor)}</strong><small>Cash minus card balances</small></div>
      <Metric label="Cash" value={overview.cash_minor} />
      <Metric label="Cards" value={overview.card_liabilities_minor} tone="amber" />
      <Metric label="This month" value={overview.income_minor - overview.spending_minor} tone={overview.income_minor >= overview.spending_minor ? "teal" : "red"} />
    </section>
    <section className="viewer-section">
      <div className="section-line"><h2>Month movement</h2><span>{formatMoney(overview.income_minor - overview.spending_minor)} net</span></div>
      <div className="movement-pair">
        <div><span>Income</span><strong className="positive">{formatMoney(overview.income_minor)}</strong></div>
        <div><span>Spending</span><strong className="negative">{formatMoney(overview.spending_minor)}</strong></div>
      </div>
    </section>
    <section className="viewer-section">
      <div className="section-line"><h2>Recent activity</h2><a href="/transactions">See all</a></div>
      <div className="activity-list">{recent.map((item) => <div key={item.id}>
        <span><strong>{item.merchant || item.description}</strong><small>{item.local_date} · {item.category || "Uncategorized"}</small></span>
        <b className={item.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(item.amount_minor, item.currency)}</b>
      </div>)}</div>
    </section>
  </div>;
}

function Freshness({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Metric({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return <div className={`viewer-metric ${tone}`}><span>{label}</span><strong>{formatMoney(value)}</strong></div>;
}

function Empty({ title }: { title: string }) { return <div className="viewer-empty"><h2>{title}</h2></div>; }

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}
