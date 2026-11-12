/** Transport errors shared by subprocess and native HTTP adapters. */
/**
 * A failed CLI or native API operation, carrying sanitized diagnostics, status codes and optional subprocess exit status.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}

/** Remote diagnostics can echo credentials; retain only codes and the classifications channels need for delivery. */
export function remoteError(value: unknown, diagnostic: unknown, exitCode?: number): CliError {
  const code = typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
  const text = typeof diagnostic === 'string' ? diagnostic : ''
  const reason = code === 403 && /locked/i.test(text) ? '; conversation locked'
    : code === 230011 ? '; message recalled'
    : code !== undefined && /withdrawn/i.test(text) ? '; message withdrawn'
    : code !== undefined && Math.floor(code / 100) === 2300 && /not found/i.test(text) ? '; message not found'
    : code === 99991400 ? '; rate limited' : ''
  const status = code === undefined ? '' : code >= 100 && code <= 599 ? ` (HTTP ${code})` : ` (error code ${code})`
  return new CliError(`Command failed${status}${reason}`, code, exitCode)
}
