import type { SolPrice } from './types.js'
import { isRecord } from './util.js'

let cache: { at: number; value: SolPrice } | null = null
const SUCCESS_TTL_MS = 60_000
const FAILURE_TTL_MS = 10_000

export function resetPriceCache(): void {
  cache = null
}

export function parseCoingeckoPrice(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.solana)) return null
  const usd = body.solana.usd
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : null
}

export function parseJupiterPrice(body: unknown): number | null {
  if (!isRecord(body)) return null
  const mint = 'So11111111111111111111111111111111111111112'
  const direct = body[mint]
  const fromData = isRecord(body.data) ? body.data[mint] : undefined
  const entry = isRecord(direct) ? direct : isRecord(fromData) ? fromData : null
  if (!entry) return null
  const raw = entry.usdPrice ?? entry.price ?? entry.usd
  const usd = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(usd) && usd > 0 ? usd : null
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_500) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

export async function getSolPriceUsd(): Promise<SolPrice> {
  const override = process.env.SOL_PRICE_USD
  if (override) {
    const usd = Number(override)
    if (Number.isFinite(usd) && usd > 0) return { usd, source: 'override' }
  }
  const now = Date.now()
  if (cache && now - cache.at < (cache.value.usd == null ? FAILURE_TTL_MS : SUCCESS_TTL_MS)) {
    return cache.value
  }

  const attempts: Array<{ source: string; url: string; parse: (body: unknown) => number | null }> = [
    {
      source: 'coingecko',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      parse: parseCoingeckoPrice,
    },
    {
      source: 'jupiter',
      url: 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
      parse: parseJupiterPrice,
    },
  ]

  for (const attempt of attempts) {
    try {
      const usd = attempt.parse(await fetchJson(attempt.url))
      if (usd != null) {
        const value = { usd, source: attempt.source }
        cache = { at: now, value }
        return value
      }
    } catch {
      // Try the next quote source.
    }
  }

  const value = { usd: null, source: null }
  cache = { at: now, value }
  return value
}
