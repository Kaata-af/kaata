export function formatAFN(amount: number): string {
  const value = Math.trunc(amount);
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-US");
  return `${value < 0 ? "-" : ""}${formatted} AFN`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
