import type { CategorizationScope } from "./categorization";

const choices: { value: CategorizationScope; symbol: string; label: string }[] = [
  { value: "one_time", symbol: "1×", label: "This transaction only" },
  { value: "future", symbol: "→", label: "This transaction and future matches" },
  { value: "past_and_future", symbol: "↔", label: "Matching past and future transactions" },
];

export function CategorizationScopeControl({
  value,
  onChange,
  disabled = false,
}: {
  value: CategorizationScope;
  onChange: (scope: CategorizationScope) => void;
  disabled?: boolean;
}) {
  return <div className="categorization-scope" role="group" aria-label="How category changes apply">
    {choices.map((choice) => <button
      key={choice.value}
      type="button"
      aria-label={choice.label}
      title={choice.label}
      aria-pressed={value === choice.value}
      disabled={disabled}
      onClick={() => onChange(choice.value)}
    >{choice.symbol}</button>)}
  </div>;
}
