export function formatMoney(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function movementWidths(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + Math.abs(value), 0);
  return values.map((value) => (value === 0 || total === 0 ? 4 : Math.round((Math.abs(value) / total) * 100)));
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

