import { PublicKey } from '@solana/web3.js'
import { ReclaimError } from './errors.js'

const pubkeyCache = new Map<string, PublicKey>()

export function asPubkey(value: string): PublicKey {
  const cached = pubkeyCache.get(value)
  if (cached) return cached
  const pubkey = new PublicKey(value)
  pubkeyCache.set(value, pubkey)
  return pubkey
}

export function parsePubkey(value: string, label = 'address'): PublicKey {
  const trimmed = value.trim()
  if (trimmed.length < 32 || trimmed.length > 44) {
    throw new ReclaimError('INVALID_ADDRESS', `Invalid Solana ${label}`)
  }
  try {
    return new PublicKey(trimmed)
  } catch {
    throw new ReclaimError('INVALID_ADDRESS', `Invalid Solana ${label}`)
  }
}

export function dedupe(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  })
  await Promise.all(workers)
  return results
}

export function idString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (
    value &&
    typeof value === 'object' &&
    'toBase58' in value &&
    typeof (value as { toBase58: unknown }).toBase58 === 'function'
  ) {
    return (value as { toBase58: () => string }).toBase58()
  }
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return 0n
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ReclaimError('RPC_TIMEOUT', `${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export function rpcHost(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export function percentOf(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null
  if (part <= 0n) return 0
  const capped = part > whole ? whole : part
  const micro = (capped * 1_000_000n) / whole
  return Number(micro) / 10_000
}

export function sumBig(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n)
}
