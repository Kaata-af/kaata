/** Phone numbers have no strong letter, so FSI alone can inherit RTL.
 * Display only: never save these controls into a phone/contact record. */
export function ltrIsolate(value: string): string {
  return `\u2066${value}\u2069`;
}
