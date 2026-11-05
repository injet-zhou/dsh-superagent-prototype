/** Transport errors shared by subprocess and native HTTP adapters. */
/**
 * A failed CLI or native API operation, carrying sanitized diagnostics, status codes and optional subprocess exit status.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
