#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import { Command } from 'commander'
import { ReclaimError } from './core/errors.js'
import { renderWalletReport } from './core/report.js'
import { auditMint } from './core/radar.js'
import { buildReclaimFromChain } from './core/reclaimer.js'
import { scanWallets } from './core/scanner.js'
import { sendSignedTransaction } from './core/send.js'
import type { TxFormat } from './core/types.js'
import { dedupe } from './core/util.js'
import { VERSION } from './core/version.js'
import { startServer } from './server.js'

const program = new Command()
program
  .name('solana-reclaim')
  .description('Scan Solana rent, dust, and creator fees, then build a 0% protocol-fee unsigned reclaim.')
  .version(VERSION)

program
  .command('scan')
  .description('Read-only scan of one or more wallets')
  .argument('<wallets...>', 'wallet addresses')
  .option('--json', 'print JSON')
  .option('--rpc <url>', 'Solana RPC URL (CLI only; the HTTP API does not accept this)')
  .option('--dust-threshold <ui>', 'whole-token dust threshold', '1')
  .option('--all', 'list every account')
  .option('--brief', 'summary only')
  .action(async (wallets: string[], opts: { json?: boolean; rpc?: string; dustThreshold: string; all?: boolean; brief?: boolean }) => {
    const threshold = Number(opts.dustThreshold)
    const batch = await scanWallets(wallets, { rpcUrl: opts.rpc, dustUiThreshold: threshold })
    if (opts.json) {
      console.log(JSON.stringify(batch, null, 2))
    } else {
      for (const scan of batch.wallets) {
        console.log(renderWalletReport(scan, { accountLimit: opts.brief ? 0 : opts.all ? Number.POSITIVE_INFINITY : 40 }))
        console.log('')
      }
      for (const error of batch.errors) console.error(`${error.address}: ${error.error}`)
    }
    if (batch.wallets.length === 0) process.exit(1)
  })

program
  .command('audit')
  .description('Token-2022 extension and holder-concentration radar')
  .argument('<mint>', 'mint address')
  .option('--json', 'print JSON')
  .option('--rpc <url>', 'Solana RPC URL')
  .action(async (mint: string, opts: { json?: boolean; rpc?: string }) => {
    const report = await auditMint(mint, { rpcUrl: opts.rpc })
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(`solana-reclaim audit  ·  ${report.symbol ?? 'unknown'} ${report.name ?? ''}`.trim())
    console.log(`Mint            ${report.mint}`)
    console.log(`Program         ${report.program}`)
    console.log(`Supply          ${report.supplyUi}`)
    console.log(`Score           ${report.score.composite}/100  ${report.score.bandLabel}`)
    console.log(`Mint authority  ${report.mintAuthority ?? 'revoked'}`)
    console.log(`Freeze authority ${report.freezeAuthority ?? 'revoked'}`)
    console.log(`Top 1 / 5 / 10  ${pct(report.concentration.circulatingTop1Pct)} / ${pct(report.concentration.circulatingTop5Pct)} / ${pct(report.concentration.circulatingTop10Pct)}`)
    console.log(`LP / vault share ${pct(report.concentration.lpSharePct)}`)
    if (report.extensions.length) {
      console.log('Extensions')
      for (const ext of report.extensions) console.log(`  ${ext.risk.padEnd(6)} ${ext.name}  ${ext.summary}`)
    }
    for (const badge of report.score.badges) console.log(`  [${badge.tone}] ${badge.label}`)
    for (const warning of report.warnings) console.log(`Warning         ${warning}`)
  })

program
  .command('build-tx')
  .description('Build unsigned close transactions. Dry-run is the default: nothing is signed unless --sign is set.')
  .argument('<wallet>', 'owner wallet')
  .option('--accounts <pubkeys>', 'comma-separated token accounts (default: all empty closeable accounts)')
  .option('--allow-burn', 'burn unprotected dust listed in --accounts')
  .option('--close-lookup-tables <pubkeys>', 'comma-separated deactivated lookup tables')
  .option('--destination <pubkey>', 'rent recipient (default: wallet)')
  .option('--priority <microLamports>', 'compute unit price', '20000')
  .option('--format <format>', 'legacy or versioned', 'legacy')
  .option('--simulate', 'simulate the unsigned batch')
  .option('--sign <keypair>', 'sign with a Solana CLI keypair JSON file')
  .option('--send', 'submit after --sign')
  .option('--dry-run', 'force unsigned output and refuse --sign')
  .option('--json', 'print JSON')
  .option('--rpc <url>', 'Solana RPC URL')
  .action(async (wallet: string, opts: {
    accounts?: string
    allowBurn?: boolean
    closeLookupTables?: string
    destination?: string
    priority: string
    format: string
    simulate?: boolean
    sign?: string
    send?: boolean
    dryRun?: boolean
    json?: boolean
    rpc?: string
  }) => {
    if (opts.dryRun && opts.sign) throw new ReclaimError('INVALID_REQUEST', '--dry-run cannot be combined with --sign')
    if (opts.send && !opts.sign) throw new ReclaimError('INVALID_REQUEST', '--send requires --sign <keypair.json>')
    if (opts.allowBurn && !opts.accounts) {
      console.error('--allow-burn only burns accounts you pass with --accounts. Empty accounts will still be closed.')
    }
    let accounts = opts.accounts ? dedupe(opts.accounts.split(',')) : undefined
    if (!accounts) {
      const batch = await scanWallets([wallet], { rpcUrl: opts.rpc })
      const scan = batch.wallets[0]
      if (!scan) throw new ReclaimError(batch.errors[0]?.code ?? 'RPC_FAILED', batch.errors[0]?.error ?? 'Scan failed')
      accounts = scan.accounts.filter((account) => account.closeable).map((account) => account.pubkey)
      if (!opts.json) console.error(`Selected ${accounts.length} empty closeable account(s).`)
    }
    const lookupTables = opts.closeLookupTables ? dedupe(opts.closeLookupTables.split(',')) : []
    const format = opts.format === 'versioned' ? 'versioned' : opts.format === 'legacy' ? 'legacy' : null
    if (!format) throw new ReclaimError('INVALID_REQUEST', 'format must be legacy or versioned')
    const built = await buildReclaimFromChain({
      wallet,
      accounts,
      lookupTables,
      allowBurn: opts.allowBurn === true,
      destination: opts.destination,
      priorityMicroLamports: Number(opts.priority),
      format: format as TxFormat,
      simulate: opts.simulate === true,
      rpcUrl: opts.rpc,
    })
    let output: unknown = built
    if (opts.sign) {
      const signer = loadKeypair(opts.sign)
      if (signer.publicKey.toBase58() !== built.wallet) {
        throw new ReclaimError('INVALID_REQUEST', 'Keypair does not match the wallet')
      }
      const signed = built.transactions.map((tx) => ({
        ...tx,
        base64: signTransaction(tx.base64, tx.format, signer),
        signed: true,
      }))
      if (opts.send) {
        const signatures = []
        for (const tx of signed) {
          signatures.push(await sendSignedTransaction(tx.base64, { rpcUrl: opts.rpc }))
        }
        output = { ...built, transactions: signed, signatures }
      } else {
        output = { ...built, transactions: signed, submitted: false }
      }
    }
    if (opts.json) console.log(JSON.stringify(output, null, 2))
    else printBuild(output)
  })

program
  .command('serve')
  .description('Start the web dashboard and API')
  .option('--port <port>', 'listen port')
  .option('--host <host>', 'bind address', '0.0.0.0')
  .action(async (opts: { port?: string; host: string }) => {
    const port = opts.port ? Number(opts.port) : undefined
    await startServer({ port, host: opts.host })
  })

function pct(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(2)}%`
}

function loadKeypair(file: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'number')) {
    throw new ReclaimError('INVALID_REQUEST', 'Keypair file must be a Solana CLI JSON byte array')
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed))
}

function signTransaction(base64: string, format: TxFormat, signer: Keypair): string {
  const raw = Buffer.from(base64, 'base64')
  if (format === 'versioned') {
    const tx = VersionedTransaction.deserialize(raw)
    tx.sign([signer])
    return Buffer.from(tx.serialize()).toString('base64')
  }
  const tx = Transaction.from(raw)
  tx.partialSign(signer)
  return tx.serialize().toString('base64')
}

function printBuild(value: unknown): void {
  const built = value as {
    protocolFeeLamports: number
    totals: { transactions: number; accounts: number; reclaimSol: string; burns: number }
    transactions: Array<{ byteLength: number; closeCount: number; burnCount: number; base64: string; kind: string }>
    warnings: string[]
    signatures?: Array<{ signature: string; explorer: string }>
  }
  console.log(`Protocol fee   ${built.protocolFeeLamports} lamports`)
  console.log(`Transactions   ${built.totals.transactions}`)
  console.log(`Accounts       ${built.totals.accounts}`)
  console.log(`Reclaim        ${built.totals.reclaimSol} SOL`)
  if (built.totals.burns) console.log(`Burns          ${built.totals.burns}`)
  for (const warning of built.warnings ?? []) console.log(`Warning        ${warning}`)
  built.transactions.forEach((tx, index) => {
    console.log('')
    console.log(`#${index + 1} ${tx.kind}  ${tx.closeCount} close  ${tx.burnCount} burn  ${tx.byteLength} bytes`)
    console.log(tx.base64)
  })
  for (const signature of built.signatures ?? []) console.log(signature.explorer)
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
})
