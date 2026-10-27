import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Server } from 'node:http'
import { ReclaimError, statusForCode } from './core/errors.js'
import { auditMint as auditMintImpl } from './core/radar.js'
import { buildReclaimFromChain as buildImpl } from './core/reclaimer.js'
import { scanWallets as scanImpl } from './core/scanner.js'
import { sendSignedTransaction as sendImpl } from './core/send.js'
import type { MintAudit, ReclaimBuild, ScanBatch } from './core/types.js'
import { dedupe, parsePubkey } from './core/util.js'
import { VERSION } from './core/version.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
export const publicDir = resolve(moduleDir, '../public')

export interface AppDeps {
  scanWallets: (wallets: string[]) => Promise<ScanBatch>
  auditMint: (mint: string) => Promise<MintAudit>
  buildReclaimFromChain: (input: Parameters<typeof buildImpl>[0]) => Promise<ReclaimBuild>
  sendSignedTransaction: (base64: string) => Promise<{ signature: string; explorer: string }>
}

const defaultDeps: AppDeps = {
  scanWallets: (wallets) => scanImpl(wallets),
  auditMint: (mint) => auditMintImpl(mint),
  buildReclaimFromChain: (input) => buildImpl(input),
  sendSignedTransaction: (base64) => sendImpl(base64),
}

export function createApp(overrides: Partial<AppDeps> = {}, options: { rateLimit?: boolean; cache?: boolean } = {}): Express {
  const deps: AppDeps = { ...defaultDeps, ...overrides }
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '128kb' }))
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  const startedAt = Date.now()
  const hits = new Map<string, number[]>()
  const scanCache = new Map<string, { at: number; value: ScanBatch }>()

  app.get('/api/health', async (req, res, next) => {
    try {
      const body: Record<string, unknown> = {
        ok: true,
        service: 'solana-reclaim',
        version: VERSION,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }
      if (req.query.deep === '1') {
        const { createRpcPool } = await import('./core/rpc.js')
        const pool = createRpcPool()
        const slot = await pool.run((connection) => connection.getSlot('confirmed'), 'getSlot', 4_000)
        body.slot = slot
        body.rpcHost = new URL(pool.endpoint).host
      }
      res.json(body)
    } catch (err) {
      next(err)
    }
  })

  const scan = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (options.rateLimit !== false) enforceRateLimit(req, hits)
      const wallets = dedupe([
        ...(typeof req.params.wallet === 'string' ? [req.params.wallet] : []),
        ...queryList(req.query.wallets),
      ])
      if (wallets.length === 0) throw new ReclaimError('INVALID_REQUEST', 'Provide at least one wallet address')
      for (const wallet of wallets) parsePubkey(wallet, 'wallet')
      const fresh = req.query.fresh === '1'
      const cacheKey = wallets.join(',')
      if (options.cache !== false && !fresh) {
        const hit = scanCache.get(cacheKey)
        if (hit && Date.now() - hit.at < 15_000) {
          res.json({ ok: hit.value.errors.length === 0 || hit.value.wallets.length > 0, ...hit.value, cached: true })
          return
        }
      }
      const batch = await deps.scanWallets(wallets)
      if (options.cache !== false && batch.wallets.length > 0) {
        scanCache.set(cacheKey, { at: Date.now(), value: batch })
      }
      if (batch.wallets.length === 0) {
        const error = batch.errors[0]
        res.status(statusForCode(error?.code ?? 'RPC_FAILED')).json({
          ok: false,
          error: error?.error ?? 'Scan failed',
          code: error?.code ?? 'RPC_FAILED',
          errors: batch.errors,
        })
        return
      }
      res.json({ ok: true, ...batch })
    } catch (err) {
      next(err)
    }
  }
  app.get('/api/scan', scan)
  app.get('/api/scan/:wallet', scan)

  app.get('/api/audit/:mint', async (req, res, next) => {
    try {
      if (options.rateLimit !== false) enforceRateLimit(req, hits)
      const mint = req.params.mint ?? ''
      parsePubkey(mint, 'mint')
      const report = await deps.auditMint(mint)
      res.json({ ok: true, ...report })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/build-reclaim-tx', async (req, res, next) => {
    try {
      if (options.rateLimit !== false) enforceRateLimit(req, hits)
      const body = isRecord(req.body) ? req.body : {}
      if (typeof body.wallet !== 'string') throw new ReclaimError('INVALID_REQUEST', 'wallet is required')
      parsePubkey(body.wallet, 'wallet')
      const accounts = body.accounts == null ? undefined : stringList(body.accounts, 'accounts')
      if (accounts && accounts.length === 0) throw new ReclaimError('INVALID_REQUEST', 'Select at least one account')
      for (const account of accounts ?? []) parsePubkey(account, 'token account')
      if (typeof body.destination === 'string') parsePubkey(body.destination, 'destination')
      let selected = accounts
      if (!selected) {
        const batch = await deps.scanWallets([body.wallet])
        const scanResult = batch.wallets[0]
        if (!scanResult) {
          throw new ReclaimError(batch.errors[0]?.code ?? 'RPC_FAILED', batch.errors[0]?.error ?? 'Scan failed')
        }
        selected = scanResult.accounts.filter((account) => account.closeable).map((account) => account.pubkey)
      }
      const built = await deps.buildReclaimFromChain({
        wallet: body.wallet,
        accounts: selected,
        allowBurn: body.allowBurn === true,
        destination: typeof body.destination === 'string' ? body.destination : undefined,
        priorityMicroLamports: body.priorityMicroLamports == null ? undefined : numberField(body.priorityMicroLamports, 'priorityMicroLamports'),
        format: body.format === 'versioned' ? 'versioned' : body.format == null || body.format === 'legacy' ? 'legacy' : badFormat(),
        simulate: body.simulate === true,
        lookupTables: body.lookupTables == null ? undefined : stringList(body.lookupTables, 'lookupTables'),
      })
      res.json({ ok: true, ...built })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/send', async (req, res, next) => {
    try {
      if (options.rateLimit !== false) enforceRateLimit(req, hits)
      const body = isRecord(req.body) ? req.body : {}
      if (typeof body.transaction !== 'string') throw new ReclaimError('INVALID_REQUEST', 'transaction base64 is required')
      const sent = await deps.sendSignedTransaction(body.transaction)
      res.json({ ok: true, ...sent })
    } catch (err) {
      next(err)
    }
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' })
  })
  app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: 0 }))
  app.use((_req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'))
  })
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err instanceof ReclaimError ? err : new ReclaimError('INTERNAL', 'Internal error')
    const status = statusForCode(error.code)
    if (!(err instanceof ReclaimError)) console.error(err)
    res.status(status).json({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.details !== undefined ? { details: error.details } : {}),
    })
  })
  return app
}

export function resolveListen(options: { port?: number; host?: string } = {}): { port: number; host: string } {
  const raw = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 43123)
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535')
  }
  return { port: raw, host: options.host ?? process.env.HOST ?? '0.0.0.0' }
}

export function startServer(options: { port?: number; host?: string; app?: Express } = {}): Promise<Server> {
  const app = options.app ?? createApp()
  const { port, host } = resolveListen(options)
  return new Promise((resolvePromise, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`solana-reclaim listening on http://${host}:${port}`)
      resolvePromise(server)
    })
    server.on('error', reject)
  })
}

function enforceRateLimit(req: Request, hits: Map<string, number[]>): void {
  const ip = req.ip || 'local'
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((stamp) => now - stamp < 60_000)
  if (recent.length >= 30) {
    throw new ReclaimError('RATE_LIMIT', 'Too many requests from this address. Wait a minute.')
  }
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5_000) hits.clear()
}

function queryList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,\s]+/)
  if (Array.isArray(value)) return value.flatMap((item) => queryList(item))
  return []
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ReclaimError('INVALID_REQUEST', `${label} must be an array of strings`)
  }
  return dedupe(value)
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ReclaimError('INVALID_REQUEST', `${label} must be an integer`)
  }
  return value
}

function badFormat(): never {
  throw new ReclaimError('INVALID_REQUEST', 'format must be legacy or versioned')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  startServer().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
