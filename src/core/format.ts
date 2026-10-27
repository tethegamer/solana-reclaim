export function lamportsToSolString(lamports: number): string {
  const negative = lamports < 0
  const abs = Math.abs(Math.trunc(lamports))
  const whole = Math.floor(abs / 1_000_000_000)
  const frac = String(abs % 1_000_000_000).padStart(9, '0').replace(/0+$/, '')
  const body = frac ? `${whole}.${frac}` : String(whole)
  return negative ? `-${body}` : body
}

export function lamportsToUsd(lamports: number, solPriceUsd: number): number | null {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd < 0) return null
  return (lamports / 1_000_000_000) * solPriceUsd
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const value = negative ? -amount : amount
  const scaleDecimals = Math.max(0, Math.min(18, decimals))
  const base = 10n ** BigInt(scaleDecimals)
  const whole = value / base
  const fraction = value % base
  const frac = scaleDecimals === 0 ? '' : fraction.toString().padStart(scaleDecimals, '0').replace(/0+$/, '')
  const body = frac ? `${whole.toString()}.${frac}` : whole.toString()
  return negative ? `-${body}` : body
}

export function shortAddress(value: string, lead = 4, tail = 4): string {
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

export function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
