export function formatMoney(minor: number, currency = "USD"): string {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  });
  const exponent = currencyExponent(currency);
  return formatter.format(minor / (10 ** exponent));
}

export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat("en-US", { style: "currency", currency })
    .resolvedOptions().maximumFractionDigits ?? 2;
}

export function minorToMajorInput(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  return (minor / (10 ** exponent)).toFixed(exponent);
}

export function majorInputToMinor(major: string, currency: string): number {
  return Math.round(Number(major) * (10 ** currencyExponent(currency)));
}

export function currencyStep(currency: string): number {
  return 1 / (10 ** currencyExponent(currency));
}

export function totalsByCurrency(
  entries: { balance_minor?: number; currency: string }[],
): { currency: string; minor: number }[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    totals.set(entry.currency, (totals.get(entry.currency) || 0) + (entry.balance_minor || 0));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, minor]) => ({ currency, minor }));
}
export function movementWidths(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + Math.abs(value), 0);
  return values.map((value) => (value === 0 || total === 0 ? 4 : Math.round((Math.abs(value) / total) * 100)));
}

export function currentMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to determine the reporting month");
  return `${year}-${month}`;
}
