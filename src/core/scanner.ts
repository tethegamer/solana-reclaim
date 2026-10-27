import type { Connection } from '@solana/web3.js'
import { collectActivity } from './activity.js'
import { classifyTokenAccount, normalizeRpcTokenAccount } from './classify.js'
import {
  DEFAULT_MAX_CLOSES_PER_TX,
  DEFAULT_PRIORITY_MICRO_LAMPORTS,
  MAX_WALLETS_PER_SCAN,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants.js'
import { ReclaimError, toReclaimError } from './errors.js'
import { lamportsToSolString, lamportsToUsd } from './format.js'
import { getSolPriceUsd } from './price.js'
import { SIZE_PROBE_BLOCKHASH, buildUnsignedReclaimTransactions, closeTargetFromAccount } from './reclaimer.js'
import { rpcRunner } from './rpc.js'
import type { AccountSummary, ClassifiedAccount, ScanBatch, SolPrice, WalletScan } from './types.js'
import { asPubkey, dedupe, mapPool, parsePubkey } from './util.js'

export interface ScanOptions {
  rpcUrl?: string
  connection?: Connection
  dustUiThreshold?: number
  price?: SolPrice
  priceProvider?: () => Promise<SolPrice>
}

const CATEGORY_ORDER = { reclaimable: 0, dust: 1, active: 2, locked: 3 } as const

export async function scanWallet(address: string, options: ScanOptions = {}): Promise<WalletScan> {
  const started = Date.now()
  const owner = parsePubkey(address, 'wallet')
  const wallet = owner.toBase58()
  const rpc = rpcRunner(options)
  const warnings: string[] = []
  const pricePromise = options.price
    ? Promise.resolve(options.price)
    : (options.priceProvider ?? getSolPriceUsd)().catch(() => ({ usd: null, source: null }))

  const [nativeLamports, spl, token2022, price] = await Promise.all([
    rpc.run((connection) => connection.getBalance(owner, 'confirmed'), 'getBalance'),
    rpc.run(
      (connection) => connection.getParsedTokenAccountsByOwner(owner, { programId: asPubkey(TOKEN_PROGRAM_ID) }, 'confirmed'),
      'SPL token accounts',
    ),
    rpc.run(
      (connection) => connection.getParsedTokenAccountsByOwner(
        owner,
        { programId: asPubkey(TOKEN_2022_PROGRAM_ID) },
        'confirmed',
      ),
      'Token-2022 accounts',
    ),
    pricePromise,
  ])

  const accounts: ClassifiedAccount[] = []
  for (const group of [spl, token2022]) {
    for (const row of group.value) {
      const pubkey = row.pubkey.toBase58()
      const data = row.account.data
      if (!('parsed' in data) || data.parsed?.type !== 'account') {
        warnings.push(`Skipped ${pubkey}: not a parsed token account.`)
        continue
      }
      const raw = normalizeRpcTokenAccount(pubkey, row.account.lamports, row.account.owner.toBase58(), data.parsed.info)
      if (!raw) {
        warnings.push(`Skipped ${pubkey}: token account data could not be read.`)
        continue
      }
      accounts.push(classifyTokenAccount(raw, { dustUiThreshold: options.dustUiThreshold }))
    }
  }

  accounts.sort((a, b) => (
    CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    || b.lamports - a.lamports
    || a.pubkey.localeCompare(b.pubkey)
  ))

  const activity = await collectActivity(rpc.run.bind(rpc), wallet, warnings)
  const reclaimable = accounts.filter((account) => account.category === 'reclaimable')
  let estimatedCloseTransactions = 0
  if (reclaimable.length > 0) {
    try {
      estimatedCloseTransactions = buildUnsignedReclaimTransactions({
        owner: wallet,
        targets: reclaimable.map(closeTargetFromAccount),
        recentBlockhash: SIZE_PROBE_BLOCKHASH,
        priorityMicroLamports: DEFAULT_PRIORITY_MICRO_LAMPORTS,
      }).transactions.length
    } catch {
      estimatedCloseTransactions = Math.ceil(reclaimable.length / DEFAULT_MAX_CLOSES_PER_TX)
      warnings.push('Batch size was estimated because a probe transaction could not be packed.')
    }
  }

  const summary: AccountSummary = {
    tokenAccounts: accounts.length,
    emptySpl: accounts.filter((account) => account.category === 'reclaimable' && account.program === 'spl-token').length,
    emptyToken2022: accounts.filter((account) => account.category === 'reclaimable' && account.program === 'token-2022').length,
    dust: accounts.filter((account) => account.category === 'dust').length,
    active: accounts.filter((account) => account.category === 'active').length,
    locked: accounts.filter((account) => account.category === 'locked').length,
    reclaimableAccounts: reclaimable.length,
    estimatedCloseTransactions,
  }
  const reclaimableLamports = reclaimable.reduce((sum, account) => sum + account.reclaimLamports, 0)
  const dustRentLamports = accounts.filter((account) => account.category === 'dust')
    .reduce((sum, account) => sum + account.potentialRentLamports, 0)
  const stuckLamports = accounts.reduce((sum, account) => sum + account.stuckLamports, 0)
  const solPriceUsd = price.usd

  return {
    address: wallet,
    nativeLamports,
    nativeSol: lamportsToSolString(nativeLamports),
    nativeUsd: solPriceUsd == null ? null : lamportsToUsd(nativeLamports, solPriceUsd),
    solPriceUsd,
    solPriceSource: price.source,
    reclaimableLamports,
    reclaimableSol: lamportsToSolString(reclaimableLamports),
    reclaimableUsd: solPriceUsd == null ? null : lamportsToUsd(reclaimableLamports, solPriceUsd),
    dustRentLamports,
    dustRentSol: lamportsToSolString(dustRentLamports),
    stuckLamports,
    accounts,
    summary,
    activity,
    warnings,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    rpcHost: rpc.host(),
  }
}

export async function scanWallets(addresses: string[], options: ScanOptions = {}): Promise<ScanBatch> {
  const started = Date.now()
  const wallets = dedupe(addresses)
  if (wallets.length === 0) throw new ReclaimError('INVALID_REQUEST', 'Provide at least one wallet address')
  if (wallets.length > MAX_WALLETS_PER_SCAN) {
    throw new ReclaimError('INVALID_REQUEST', `Scan at most ${MAX_WALLETS_PER_SCAN} wallets at once`)
  }
  for (const wallet of wallets) parsePubkey(wallet, 'wallet')

  const price = options.price ?? await (options.priceProvider ?? getSolPriceUsd)().catch(() => ({ usd: null, source: null }))
  const results = await mapPool(wallets, 2, async (wallet) => {
    try {
      const scan = await scanWallet(wallet, { ...options, price })
      return { ok: true as const, scan }
    } catch (err) {
      const wrapped = toReclaimError(err, 'scan')
      return { ok: false as const, address: wallet, error: wrapped.message, code: wrapped.code }
    }
  })

  return {
    wallets: results.flatMap((result) => result.ok ? [result.scan] : []),
    errors: results.flatMap((result) => result.ok ? [] : [{
      address: result.address,
      error: result.error,
      code: result.code,
    }]),
    solPriceUsd: price.usd,
    solPriceSource: price.source,
    durationMs: Date.now() - started,
    rpcHost: results.find((result) => result.ok)?.scan.rpcHost ?? null,
  }
}
