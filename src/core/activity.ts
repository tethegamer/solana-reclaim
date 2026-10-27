import { Connection } from '@solana/web3.js'
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  IGNORED_PROGRAM_IDS,
  PROGRAM_BY_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  WSOL_MINT,
} from './constants.js'
import { decodeLookupTable, lookupTableCloseStatus, readTokenAccountBase } from './decode.js'
import { sanitizeRpcMessage } from './errors.js'
import { formatTokenAmount, lamportsToSolString } from './format.js'
import { deriveCreatorFeeAccounts } from './pdas.js'
import { claimableAfterRent } from './rent.js'
import type { CreatorFeeSurface, LookupTableScan, ProgramTouch, WalletActivity } from './types.js'
import { asPubkey, idString } from './util.js'

const CREATOR_NOTE =
  'The pump.fun bonding-curve creator vault is the PDA ["creator-vault", wallet]. PumpSwap creator fees sit in a wSOL token account owned by the PDA ["creator_vault", wallet], not by the wallet itself, so they are not closed by the reclaim batch. Fee-sharing configs can point fees at a different vault than this direct derivation.'

type Run = <T>(op: (connection: Connection) => Promise<T>, label: string, timeoutMs?: number) => Promise<T>

function warn(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return sanitizeRpcMessage(raw)
}

export async function collectActivity(run: Run, wallet: string, warnings: string[]): Promise<WalletActivity> {
  const programs = new Map<string, ProgramTouch>()
  let signaturesConsidered = 0
  let transactionsSampled = 0

  try {
    const signatures = await run(
      (connection) => connection.getSignaturesForAddress(asPubkey(wallet), { limit: 20 }),
      'getSignaturesForAddress',
      12_000,
    )
    signaturesConsidered = signatures.length
    const sample = signatures.filter((sig) => !sig.err).slice(0, 4).map((sig) => sig.signature)
    const parsed = []
    for (const signature of sample) {
      try {
        parsed.push(await run(
          (connection) => connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }),
          'getParsedTransaction',
          12_000,
        ))
      } catch (err) {
        warnings.push(`Stopped reading recent transactions (${warn(err)}).`)
        break
      }
    }
    if (sample.length > 0) {
      transactionsSampled = parsed.filter(Boolean).length
      for (const tx of parsed) {
        if (!tx) continue
        const instructions = [
          ...tx.transaction.message.instructions,
          ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
        ]
        for (const instruction of instructions) {
          const programId = idString('programId' in instruction ? instruction.programId : null)
          if (!programId || IGNORED_PROGRAM_IDS.has(programId)) continue
          const known = PROGRAM_BY_ID.get(programId)
          const current = programs.get(programId) ?? {
            id: programId,
            name: known?.name ?? 'Unknown program',
            kind: known?.kind ?? 'other',
            hits: 0,
          }
          current.hits += 1
          programs.set(programId, current)
        }
      }
    }
  } catch (err) {
    warnings.push(`Recent program activity was not fully read (${warn(err)}).`)
  }

  const creatorFees = await readCreatorFees(run, wallet, warnings)
  const lookupTables = await readLookupTables(run, wallet, warnings)

  return {
    signaturesConsidered,
    transactionsSampled,
    programs: [...programs.values()].sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name)).slice(0, 12),
    lookupTables,
    creatorFees,
  }
}

async function readCreatorFees(run: Run, wallet: string, warnings: string[]): Promise<CreatorFeeSurface> {
  const derived = deriveCreatorFeeAccounts(wallet)
  const empty: CreatorFeeSurface = {
    note: CREATOR_NOTE,
    pumpCreatorVault: {
      address: derived.pumpCreatorVault,
      exists: false,
      owner: null,
      lamports: 0,
      claimableLamports: 0,
      claimableSol: '0',
    },
    pumpSwapWsolAta: {
      address: derived.pumpSwapWsolAta,
      authority: derived.pumpSwapCreatorAuthority,
      exists: false,
      amount: '0',
      uiAmount: '0',
      rentLamports: 0,
      mintMatches: false,
    },
  }

  try {
    const infos = await run(
      (connection) => connection.getMultipleAccountsInfo([
        asPubkey(derived.pumpCreatorVault),
        asPubkey(derived.pumpSwapWsolAta),
      ], 'confirmed'),
      'creator fee accounts',
      12_000,
    )
    const [vault, ata] = infos
    if (vault) {
      const owner = vault.owner.toBase58()
      const expected = owner === SYSTEM_PROGRAM_ID || owner === PUMP_PROGRAM_ID
      const claimable = expected ? claimableAfterRent(vault.lamports, vault.data.length) : 0
      if (!expected) warnings.push('The pump.fun creator-vault address exists but is not owned by the system or pump program.')
      empty.pumpCreatorVault = {
        address: derived.pumpCreatorVault,
        exists: true,
        owner,
        lamports: vault.lamports,
        claimableLamports: claimable,
        claimableSol: lamportsToSolString(claimable),
      }
    }
    if (ata) {
      const base = readTokenAccountBase(ata.data)
      const mintMatches = base?.mint === WSOL_MINT && base.owner === derived.pumpSwapCreatorAuthority
      empty.pumpSwapWsolAta = {
        address: derived.pumpSwapWsolAta,
        authority: derived.pumpSwapCreatorAuthority,
        exists: true,
        amount: mintMatches && base ? base.amount.toString() : '0',
        uiAmount: mintMatches && base ? formatTokenAmount(base.amount, 9) : '0',
        rentLamports: ata.lamports,
        mintMatches,
      }
      if (!mintMatches) warnings.push('A PumpSwap creator-vault token account exists but does not match the expected wSOL mint.')
    }
  } catch (err) {
    warnings.push(`Creator-fee accounts were not read (${warn(err)}).`)
  }

  return empty
}

async function readLookupTables(run: Run, wallet: string, warnings: string[]): Promise<LookupTableScan> {
  try {
    const found = await run(
      (connection) => connection.getProgramAccounts(asPubkey(ADDRESS_LOOKUP_TABLE_PROGRAM_ID), {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 22, bytes: wallet } }],
      }),
      'address lookup tables',
      8_000,
    )
    let slot = 0n
    if (found.length > 0) {
      try {
        slot = BigInt(await run((connection) => connection.getSlot('confirmed'), 'getSlot', 8_000))
      } catch (err) {
        warnings.push(`Current slot was not read, so lookup tables are not marked closeable (${warn(err)}).`)
      }
    }
    const tables = found.flatMap((row) => {
      const decoded = decodeLookupTable(row.account.data)
      if (!decoded) return []
      const status = lookupTableCloseStatus(decoded, slot, wallet)
      return [{
        address: row.pubkey.toBase58(),
        lamports: row.account.lamports,
        sol: lamportsToSolString(row.account.lamports),
        addressesStored: decoded.addresses.length,
        active: decoded.active,
        closeable: status.closeable,
        authority: decoded.authority,
        deactivationSlot: decoded.deactivationSlot.toString(),
        reason: status.reason,
      }]
    }).sort((a, b) => b.lamports - a.lamports)
    const reclaimableLamports = tables.filter((table) => table.closeable).reduce((sum, table) => sum + table.lamports, 0)
    return {
      status: 'ok',
      detail: null,
      tables,
      reclaimableLamports,
      reclaimableSol: lamportsToSolString(reclaimableLamports),
    }
  } catch (err) {
    warnings.push('Address lookup tables could not be listed. Public RPCs often disable getProgramAccounts.')
    return {
      status: 'unavailable',
      detail: warn(err),
      tables: [],
      reclaimableLamports: 0,
      reclaimableSol: '0',
    }
  }
}
