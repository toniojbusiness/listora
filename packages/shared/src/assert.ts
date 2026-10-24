/**
 * Exhaustiveness guard for switches over unions (for example marketplace capability modes).
 * Adding a union member without handling it becomes a type error at every switch.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
