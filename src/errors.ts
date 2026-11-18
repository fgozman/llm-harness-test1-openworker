// Small helpers for working with thrown values.

/** The message of a thrown value, whatever its type. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
