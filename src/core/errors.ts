export class ReclaimError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ReclaimError'
    this.code = code
    this.details = details
  }
}

export function statusForCode(code: string): number {
  switch (code) {
    case 'INVALID_ADDRESS':
    case 'INVALID_REQUEST':
    case 'ACCOUNT_NOT_ELIGIBLE':
    case 'INVALID_TRANSACTION':
      return 400
    case 'NOT_A_MINT':
      return 422
    case 'NOT_FOUND':
      return 404
    case 'RATE_LIMIT':
      return 429
    case 'RPC_TIMEOUT':
      return 504
    case 'RPC_FAILED':
      return 502
    default:
      return 500
  }
}

export function sanitizeRpcMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, (url) => {
      try {
        return new URL(url).host
      } catch {
        return 'rpc'
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

export function toReclaimError(err: unknown, label: string): ReclaimError {
  if (err instanceof ReclaimError) return err
  const raw = err instanceof Error ? err.message : String(err)
  const code = /timed out/i.test(raw) ? 'RPC_TIMEOUT' : 'RPC_FAILED'
  const wrapped = new ReclaimError(code, `${label} failed (${sanitizeRpcMessage(raw) || 'unknown RPC error'})`)
  wrapped.cause = err
  return wrapped
}
