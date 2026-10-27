import { Connection } from '@solana/web3.js'
import { DEFAULT_RPC_URL, PUBLIC_FALLBACK_RPC_URLS } from './constants.js'
import { toReclaimError } from './errors.js'
import { dedupe, rpcHost, sleep, withTimeout } from './util.js'

const fetchWithTimeout: typeof fetch = (input, init) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  if (init?.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

export function resolveRpcUrls(explicit?: string): string[] {
  const fromEnv = process.env.SOLANA_RPC_URL ? [process.env.SOLANA_RPC_URL] : []
  const fallbacks = (process.env.SOLANA_RPC_FALLBACKS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return dedupe([
    ...(explicit ? [explicit] : []),
    ...fromEnv,
    DEFAULT_RPC_URL,
    ...fallbacks,
    ...PUBLIC_FALLBACK_RPC_URLS,
  ])
}

export class RpcPool {
  lastUrl: string | null = null
  private readonly connections = new Map<string, Connection>()

  constructor(private readonly urls: string[]) {
    if (urls.length === 0) throw new Error('At least one RPC URL is required')
  }

  get endpoint(): string {
    return this.lastUrl ?? this.urls[0] ?? DEFAULT_RPC_URL
  }

  connectionFor(url: string): Connection {
    let connection = this.connections.get(url)
    if (!connection) {
      connection = new Connection(url, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: fetchWithTimeout,
      })
      this.connections.set(url, connection)
    }
    return connection
  }

  private order(): string[] {
    if (!this.lastUrl) return this.urls
    return [this.lastUrl, ...this.urls.filter((url) => url !== this.lastUrl)]
  }

  async run<T>(op: (connection: Connection) => Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
    const order = this.order()
    let last: unknown
    for (let i = 0; i < order.length; i++) {
      const url = order[i]
      if (!url) continue
      try {
        const value = await withTimeout(op(this.connectionFor(url)), timeoutMs, label)
        this.lastUrl = url
        return value
      } catch (err) {
        last = err
        const message = err instanceof Error ? err.message : String(err)
        const rateLimited = /429|too many requests|rate/i.test(message)
        if (i < order.length - 1) await sleep(rateLimited ? 900 : 200 * (i + 1))
      }
    }
    throw toReclaimError(last, label)
  }
}

export function createRpcPool(explicit?: string): RpcPool {
  return new RpcPool(resolveRpcUrls(explicit))
}

export interface RpcRunner {
  pool: RpcPool | null
  run<T>(op: (connection: Connection) => Promise<T>, label: string, timeoutMs?: number): Promise<T>
  host(): string | null
}

export function rpcRunner(options: { connection?: Connection; rpcUrl?: string } = {}): RpcRunner {
  const pool = options.connection ? null : createRpcPool(options.rpcUrl)
  return {
    pool,
    run(op, label, timeoutMs = 20_000) {
      if (options.connection) return withTimeout(op(options.connection), timeoutMs, label)
      if (!pool) throw new Error('RPC pool was not created')
      return pool.run(op, label, timeoutMs)
    },
    host() {
      return rpcHost(pool?.lastUrl ?? pool?.endpoint ?? options.connection?.rpcEndpoint ?? null)
    },
  }
}
