const FORMATTER = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return FORMATTER.format(Math.trunc(value));
}
