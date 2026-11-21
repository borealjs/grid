const defaultNumberFormat = new Intl.NumberFormat();

/** Default text for a value: '' for null/undefined, locale formatting for numbers, String() otherwise. */
export function defaultFormat(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? defaultNumberFormat.format(value) : String(value);
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}
