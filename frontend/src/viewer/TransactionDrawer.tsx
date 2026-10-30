import { X } from "lucide-react";
import { formatMoney } from "../format";
import type { RemoteTransaction } from "./model";
import type { ClassificationTaxonomy } from "./model";
import type { MobileCommand } from "./mobileCommands";
import { TransactionClassificationEditor } from "./TransactionClassificationEditor";

export function TransactionDrawer({ transaction, taxonomy, command, editingAvailable, onSave, onCancel, onClose }: {
  transaction: RemoteTransaction;
  taxonomy: ClassificationTaxonomy | null;
  command?: MobileCommand;
  editingAvailable: boolean;
  onSave: (input: { categoryId: string | null; subcategoryId: string | null; replaceCommandId: string | null; observedRevision?: number }) => Promise<void>;
  onCancel: (commandId: string) => Promise<void>;
  onClose: () => void;
}) {
  return <div className="viewer-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="viewer-drawer" role="dialog" aria-modal="true" aria-labelledby="transaction-title">
      <button className="drawer-close" aria-label="Close transaction details" onClick={onClose}><X /></button>
      <span className="drawer-date">{transaction.local_date}</span>
      <h2 id="transaction-title">{transaction.merchant || transaction.description}</h2>
      <strong className={`drawer-amount ${transaction.amount_minor < 0 ? "negative" : "positive"}`}>{formatMoney(transaction.amount_minor, transaction.currency)}</strong>
      <dl>
        <Detail label="Description" value={transaction.description} />
        <Detail label="Category" value={[transaction.category, transaction.subcategory].filter(Boolean).join(" / ") || "Uncategorized"} />
        <Detail label="Spent by" value={transaction.spending_owner || "Not applicable"} />
        <Detail label="Account" value={`${transaction.account_name}${transaction.account_mask ? ` ····${transaction.account_mask}` : ""}`} />
        <Detail label="Institution" value={transaction.institution_name || "Manual entry"} />
        <Detail label="Account type" value={[transaction.account_type, transaction.account_subtype].filter(Boolean).join(" · ")} />
        <Detail label="Status" value={transaction.pending ? "Pending" : "Posted"} />
        {transaction.is_cash_withdrawal && <Detail label="Transaction type" value="Cash withdrawal" />}
      </dl>
      {editingAvailable && taxonomy && <TransactionClassificationEditor transaction={transaction} taxonomy={taxonomy} command={command} onSave={onSave} onCancel={onCancel} />}
    </aside>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
