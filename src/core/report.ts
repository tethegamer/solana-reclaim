import { formatUsd, lamportsToSolString, shortAddress } from './format.js'
import type { WalletScan } from './types.js'

export function renderWalletReport(scan: WalletScan, options: { accountLimit?: number } = {}): string {
  const limit = options.accountLimit ?? 40
  const price = scan.solPriceUsd == null ? 'USD quote unavailable' : `${formatUsd(scan.solPriceUsd)} / SOL via ${scan.solPriceSource}`
  const lines = [
    'solana-reclaim  ·  read-only scan  ·  0% protocol fee',
    '',
    `Wallet          ${scan.address}`,
    `Native SOL      ${scan.nativeSol}${scan.nativeUsd == null ? '' : `   (${formatUsd(scan.nativeUsd)})`}`,
    `Closeable rent  ${scan.reclaimableSol} SOL${scan.reclaimableUsd == null ? '' : `   (${formatUsd(scan.reclaimableUsd)})`}`,
    `Quote           ${price}`,
    `Empty SPL       ${scan.summary.emptySpl}`,
    `Empty Token-2022 ${scan.summary.emptyToken2022}`,
    `Dust            ${scan.summary.dust}   (${scan.dustRentSol} SOL rent if burned)`,
    `Active          ${scan.summary.active}`,
    `Locked          ${scan.summary.locked}   (${scan.stuckLamports} lamports stuck)`,
    `Close batches   ${scan.summary.estimatedCloseTransactions}`,
    `RPC             ${scan.rpcHost ?? 'unknown'}   ${scan.durationMs}ms`,
  ]

  const vault = scan.activity.creatorFees.pumpCreatorVault
  const swap = scan.activity.creatorFees.pumpSwapWsolAta
  lines.push(
    `pump.fun vault  ${vault.exists ? `${vault.claimableSol} SOL claimable` : 'none'}   ${shortAddress(vault.address, 6, 6)}`,
    `PumpSwap wSOL   ${swap.exists ? `${swap.uiAmount} wSOL` : 'none'}`,
  )

  const tables = scan.activity.lookupTables
  if (tables.status === 'unavailable') {
    lines.push('Lookup tables   unavailable on this RPC')
  } else if (tables.tables.length === 0) {
    lines.push('Lookup tables   none owned by this wallet')
  } else {
    const closeable = tables.tables.filter((table) => table.closeable).length
    lines.push(`Lookup tables   ${tables.tables.length} owned, ${closeable} closeable, ${tables.reclaimableSol} SOL`)
  }

  if (scan.activity.programs.length > 0) {
    lines.push('', 'Recent programs')
    for (const program of scan.activity.programs.slice(0, 8)) {
      lines.push(`  ${String(program.hits).padStart(3)}  ${program.name}  ${shortAddress(program.id, 6, 6)}`)
    }
  }

  const visible = scan.accounts.slice(0, limit)
  if (visible.length > 0) {
    lines.push('', 'Accounts')
    for (const account of visible) {
      const label = account.mintLabel ? `${account.mintLabel} ` : ''
      const rent = lamportsToSolString(account.reclaimLamports || account.potentialRentLamports || account.lamports)
      lines.push(`  ${account.category.padEnd(12)} ${account.program.padEnd(12)} ${rent} SOL`)
      lines.push(`    ${label}${shortAddress(account.mint, 4, 4)}  ${account.uiAmountString}  ${shortAddress(account.pubkey, 4, 4)}  ${account.reasons[0] ?? ''}`)
    }
    if (scan.accounts.length > visible.length) {
      lines.push(`  … ${scan.accounts.length - visible.length} more (use --all or --json)`)
    }
  }

  if (scan.warnings.length > 0) {
    lines.push('', 'Warnings')
    for (const warning of scan.warnings) lines.push(`  - ${warning}`)
  }
  return lines.join('\n')
}
