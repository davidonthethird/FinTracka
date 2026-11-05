import { useEffect, useRef } from "react";

import { formatMoney } from "../format";

export type TransferTransaction = {
  id: string;
  local_date: string;
  amount_minor: number;
  currency: string;
  description: string;
  merchant?: string;
  account_name: string;
  account_nickname?: string;
  account_mask?: string;
};

type Props = {
  source: TransferTransaction;
  matches?: TransferTransaction[];
  selectedId?: string;
  loading: boolean;
  error: string;
  onSelect: (transactionId: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function transferConfirmationRequest(anchorId: string, matchId: string) {
  return {
    path: `/transfers/${anchorId}/confirm`,
    init: {
      method: "POST",
      body: JSON.stringify({ transaction_a: anchorId, transaction_b: matchId }),
    },
  };
}

export function TransferConnectDialog({
  source,
  matches,
  selectedId,
  loading,
  error,
  onSelect,
  onConfirm,
  onClose,
}: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="flow-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="flow-drawer transfer-connect" role="dialog" aria-modal="true" aria-label="Connect transfer">
      <div className="section-heading">
        <div><p className="eyebrow">Manual match</p><h2>Connect transfer</h2></div>
        <button ref={closeButton} className="quiet-button" aria-label="Close transfer connection" onClick={onClose}>Close</button>
      </div>
      <section className="transfer-connect-source">
        <small>Selected transaction</small>
        <strong>{source.merchant || source.description}</strong>
        <span>{source.local_date} · {accountLabel(source)}</span>
        <b className={source.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(source.amount_minor, source.currency)}</b>
      </section>
      <p className="transfer-connect-help">Choose the exact opposite transaction. Connecting only changes FinTracka reporting; it does not move money.</p>
      {loading ? <p className="drawer-feedback">Finding exact matches…</p>
        : error ? <p className="drawer-feedback error" role="alert">{error}</p>
        : matches?.length ? <fieldset className="transfer-match-list"><legend>Matching transactions</legend>{matches.map((match) => <label key={match.id} className={selectedId === match.id ? "selected" : ""}>
          <input type="radio" name="transfer-match" value={match.id} checked={selectedId === match.id} onChange={() => onSelect(match.id)} />
          <span><strong>{match.merchant || match.description}</strong><small>{match.local_date} · {accountLabel(match)}</small></span>
          <b className={match.amount_minor < 0 ? "negative" : "positive"}>{formatMoney(match.amount_minor, match.currency)}</b>
        </label>)}</fieldset>
        : <p className="drawer-feedback">No exact opposite transaction is available yet. It may appear after the other account syncs.</p>}
      <div className="drawer-actions">
        <button className="quiet-button" onClick={onClose}>Cancel</button>
        <button disabled={!selectedId || loading || Boolean(error)} onClick={onConfirm}>Confirm transfer</button>
      </div>
    </aside>
  </div>;
}

function accountLabel(transaction: TransferTransaction): string {
  return `${transaction.account_nickname || transaction.account_name}${transaction.account_mask ? ` •••• ${transaction.account_mask}` : ""}`;
}
