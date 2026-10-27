import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { USDC_MINT } from '../src/core/constants.js'
import { createApp } from '../src/server.js'
import type { MintAudit, ReclaimBuild, ScanBatch, WalletScan } from '../src/core/types.js'
import { address } from './helpers.js'

const wallet = address(1)

function scanFixture(): WalletScan {
  return {
    address: wallet,
    nativeLamports: 1_000_000_000,
    nativeSol: '1',
    nativeUsd: 100,
    solPriceUsd: 100,
    solPriceSource: 'test',
    reclaimableLamports: 2_039_280,
    reclaimableSol: '0.00203928',
    reclaimableUsd: 0.2,
    dustRentLamports: 0,
    dustRentSol: '0',
    stuckLamports: 0,
    accounts: [],
    summary: {
      tokenAccounts: 1,
      emptySpl: 1,
      emptyToken2022: 0,
      dust: 0,
      active: 0,
      locked: 0,
      reclaimableAccounts: 1,
      estimatedCloseTransactions: 1,
    },
    activity: {
      signaturesConsidered: 0,
      transactionsSampled: 0,
      programs: [],
      lookupTables: { status: 'ok', detail: null, tables: [], reclaimableLamports: 0, reclaimableSol: '0' },
      creatorFees: {
        note: 'test',
        pumpCreatorVault: {
          address: address(2),
          exists: false,
          owner: null,
          lamports: 0,
          claimableLamports: 0,
          claimableSol: '0',
        },
        pumpSwapWsolAta: {
          address: address(3),
          authority: address(4),
          exists: false,
          amount: '0',
          uiAmount: '0',
          rentLamports: 0,
          mintMatches: false,
        },
      },
    },
    warnings: [],
    scannedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 5,
    rpcHost: 'rpc.test',
  }
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const info = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${info.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

describe('HTTP API', () => {
  const app = createApp({
    scanWallets: async (wallets): Promise<ScanBatch> => ({
      wallets: wallets.map((item) => ({ ...scanFixture(), address: item })),
      errors: [],
      solPriceUsd: 100,
      solPriceSource: 'test',
      durationMs: 5,
      rpcHost: 'rpc.test',
    }),
    auditMint: async (mint): Promise<MintAudit> => ({
      mint,
      name: 'USD Coin',
      symbol: 'USDC',
      uri: null,
      program: 'spl-token',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 6,
      supply: '1',
      supplyUi: '0.000001',
      mintAuthority: null,
      freezeAuthority: null,
      recognized: true,
      mintLabel: 'USDC',
      extensions: [],
      score: {
        composite: 100,
        authority: 100,
        distribution: 100,
        band: 'lower-risk',
        bandLabel: 'Lower structural risk',
        criticalCap: false,
        protectedFloor: false,
        breakdown: [],
        badges: [],
        summary: 'test',
      },
      concentration: {
        available: true,
        sampleSize: 0,
        excludedCount: 0,
        lpSharePct: 0,
        circulatingTop1Pct: 0,
        circulatingTop5Pct: 0,
        circulatingTop10Pct: 0,
        rawTop1Pct: 0,
        rawTop10Pct: 0,
        note: 'test',
        holders: [],
      },
      warnings: [],
      scannedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 4,
      rpcHost: 'rpc.test',
    }),
    buildReclaimFromChain: async (): Promise<ReclaimBuild> => ({
      wallet,
      destination: wallet,
      recentBlockhash: 'blockhash',
      lastValidBlockHeight: 1,
      priorityMicroLamports: 20_000,
      protocolFeeLamports: 0,
      format: 'legacy',
      totals: {
        transactions: 1,
        accounts: 1,
        closes: 1,
        burns: 0,
        reclaimLamports: 2_039_280,
        reclaimSol: '0.00203928',
        lookupTables: 0,
      },
      transactions: [],
      warnings: [],
    }),
  }, { rateLimit: false, cache: false })

  it('serves health, the dashboard, and rejects bad input', async () => {
    const running = await listen(app)
    try {
      const home = await fetch(`${running.url}/`)
      expect(home.status).toBe(200)
      expect(await home.text()).toContain('solana-reclaim')

      const health = await fetch(`${running.url}/api/health`)
      expect(health.status).toBe(200)
      const healthBody = await health.json() as { ok: boolean; service: string }
      expect(healthBody).toMatchObject({ ok: true, service: 'solana-reclaim' })

      const missing = await fetch(`${running.url}/api/scan/not-a-wallet`)
      expect(missing.status).toBe(400)

      const scan = await fetch(`${running.url}/api/scan/${wallet}?wallets=${address(5)}`)
      expect(scan.status).toBe(200)
      const scanBody = await scan.json() as { wallets: Array<{ address: string }> }
      expect(scanBody.wallets.map((item) => item.address).sort()).toEqual([wallet, address(5)].sort())

      const audit = await fetch(`${running.url}/api/audit/${USDC_MINT}`)
      expect(audit.status).toBe(200)
      const auditBody = await audit.json() as { symbol: string; score: { composite: number } }
      expect(auditBody.symbol).toBe('USDC')
      expect(auditBody.score.composite).toBe(100)

      const badAudit = await fetch(`${running.url}/api/audit/nope`)
      expect(badAudit.status).toBe(400)

      const built = await fetch(`${running.url}/api/build-reclaim-tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet, accounts: [address(10)] }),
      })
      expect(built.status).toBe(200)
      const builtBody = await built.json() as { protocolFeeLamports: number; totals: { reclaimSol: string } }
      expect(builtBody.protocolFeeLamports).toBe(0)
      expect(builtBody.totals.reclaimSol).toBe('0.00203928')

      const badBuild = await fetch(`${running.url}/api/build-reclaim-tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(badBuild.status).toBe(400)

      const badSend = await fetch(`${running.url}/api/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: '@@@' }),
      })
      expect(badSend.status).toBeGreaterThanOrEqual(400)

      const unknown = await fetch(`${running.url}/api/missing`)
      expect(unknown.status).toBe(404)
    } finally {
      await running.close()
    }
  })
})
