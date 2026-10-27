import {
  createBurnInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token'
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import { classifyTokenAccount, normalizeRpcTokenAccount } from './classify.js'
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  DEFAULT_MAX_CLOSES_PER_TX,
  DEFAULT_PRIORITY_MICRO_LAMPORTS,
  MAX_ACCOUNTS_PER_BUILD,
  MAX_CLOSES_PER_TX,
  MAX_PRIORITY_MICRO_LAMPORTS,
  PACKET_DATA_SIZE,
  PROTOCOL_FEE_LAMPORTS,
} from './constants.js'
import { decodeLookupTable, lookupTableCloseStatus } from './decode.js'
import { ReclaimError } from './errors.js'
import { lamportsToSolString } from './format.js'
import { rpcRunner } from './rpc.js'
import type {
  BuiltTransaction,
  ClassifiedAccount,
  CloseTarget,
  LookupCloseTarget,
  ReclaimBuild,
  SimulationResult,
  TxFormat,
} from './types.js'
import { asPubkey, dedupe, mapPool, parsePubkey } from './util.js'

export const SIZE_PROBE_BLOCKHASH = new PublicKey(Buffer.alloc(32, 8)).toBase58()

export interface BuildTransactionsInput {
  owner: string
  destination?: string
  targets: CloseTarget[]
  recentBlockhash: string
  allowBurn?: boolean
  priorityMicroLamports?: number
  maxClosesPerTx?: number
  format?: TxFormat
}

export interface BuildFromChainInput {
  wallet: string
  accounts?: string[]
  allowBurn?: boolean
  destination?: string
  priorityMicroLamports?: number
  maxClosesPerTx?: number
  format?: TxFormat
  simulate?: boolean
  lookupTables?: string[]
  dustUiThreshold?: number
  connection?: Connection
  rpcUrl?: string
}

export function closeTargetFromAccount(account: ClassifiedAccount): CloseTarget {
  return {
    pubkey: account.pubkey,
    programId: account.programId,
    lamports: account.lamports,
    mint: account.mint,
    amount: account.amount,
    decimals: account.decimals,
    closeable: account.closeable,
    burnable: account.burnable,
    protectedMint: account.protectedMint,
  }
}

function assertBuildOptions(input: {
  priorityMicroLamports?: number
  maxClosesPerTx?: number
  format?: TxFormat
}): { priority: number; maxCloses: number; format: TxFormat } {
  const priority = input.priorityMicroLamports ?? DEFAULT_PRIORITY_MICRO_LAMPORTS
  const maxCloses = input.maxClosesPerTx ?? DEFAULT_MAX_CLOSES_PER_TX
  const format = input.format ?? 'legacy'
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY_MICRO_LAMPORTS) {
    throw new ReclaimError(
      'INVALID_REQUEST',
      `priorityMicroLamports must be an integer from 0 to ${MAX_PRIORITY_MICRO_LAMPORTS}`,
    )
  }
  if (!Number.isInteger(maxCloses) || maxCloses < 1 || maxCloses > MAX_CLOSES_PER_TX) {
    throw new ReclaimError('INVALID_REQUEST', `maxClosesPerTx must be an integer from 1 to ${MAX_CLOSES_PER_TX}`)
  }
  if (format !== 'legacy' && format !== 'versioned') {
    throw new ReclaimError('INVALID_REQUEST', 'format must be legacy or versioned')
  }
  return { priority, maxCloses, format }
}

function eligibleMode(target: CloseTarget, allowBurn: boolean): 'close' | 'burn' {
  if (target.protectedMint && target.amount !== '0') {
    throw new ReclaimError(
      'ACCOUNT_NOT_ELIGIBLE',
      `${target.pubkey} holds a recognized mint and will not be burned`,
    )
  }
  if (target.closeable && target.amount === '0') return 'close'
  if (allowBurn && target.burnable && target.amount !== '0') return 'burn'
  const hint = target.amount !== '0' && !allowBurn ? ' Pass allowBurn to burn unprotected dust.' : ''
  throw new ReclaimError('ACCOUNT_NOT_ELIGIBLE', `${target.pubkey} cannot be closed.${hint}`)
}

function instructionsFor(
  target: CloseTarget,
  owner: PublicKey,
  destination: PublicKey,
  allowBurn: boolean,
): TransactionInstruction[] {
  const mode = eligibleMode(target, allowBurn)
  const account = asPubkey(target.pubkey)
  const program = asPubkey(target.programId)
  const instructions: TransactionInstruction[] = []
  if (mode === 'burn') {
    instructions.push(createBurnInstruction(account, asPubkey(target.mint), owner, BigInt(target.amount), [], program))
  }
  instructions.push(createCloseAccountInstruction(account, destination, owner, [], program))
  return instructions
}

function budgetInstructions(closeCount: number, burnCount: number, priority: number): TransactionInstruction[] {
  const units = Math.min(1_400_000, 20_000 + closeCount * 12_000 + burnCount * 20_000)
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units })]
  if (priority > 0) instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }))
  return instructions
}

function uniqueIds(instructions: TransactionInstruction[]): string[] {
  return [...new Set(instructions.map((instruction) => instruction.programId.toBase58()))]
}

function serialize(
  instructions: TransactionInstruction[],
  owner: PublicKey,
  blockhash: string,
  format: TxFormat,
): { base64: string; byteLength: number } {
  if (format === 'legacy') {
    const tx = new Transaction()
    tx.feePayer = owner
    tx.recentBlockhash = blockhash
    tx.add(...instructions)
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    return { base64: bytes.toString('base64'), byteLength: bytes.length }
  }
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message()
  const bytes = Buffer.from(new VersionedTransaction(message).serialize())
  return { base64: bytes.toString('base64'), byteLength: bytes.length }
}

function compileGroup(
  targets: CloseTarget[],
  owner: PublicKey,
  destination: PublicKey,
  blockhash: string,
  allowBurn: boolean,
  priority: number,
  format: TxFormat,
  kind: BuiltTransaction['kind'] = 'token-close',
): BuiltTransaction {
  const body = targets.flatMap((target) => instructionsFor(target, owner, destination, allowBurn))
  const burnCount = body.filter((instruction) => instruction.data[0] === 8).length
  const closeCount = body.filter((instruction) => instruction.data[0] === 9).length
  const instructions = [...budgetInstructions(closeCount, burnCount, priority), ...body]
  const wire = serialize(instructions, owner, blockhash, format)
  const reclaimLamports = targets.reduce((sum, target) => sum + target.lamports, 0)
  return {
    kind,
    format,
    base64: wire.base64,
    byteLength: wire.byteLength,
    accountPubkeys: targets.map((target) => target.pubkey),
    programIds: uniqueIds(instructions),
    reclaimLamports,
    reclaimSol: lamportsToSolString(reclaimLamports),
    instructionCount: instructions.length,
    closeCount,
    burnCount,
  }
}

function packGroups<T>(
  items: T[],
  maxCount: number,
  measure: (group: T[]) => number,
): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  const flush = () => {
    if (current.length === 0) return
    groups.push(current)
    current = []
  }
  for (const item of items) {
    if (current.length === 0) {
      if (measure([item]) > PACKET_DATA_SIZE) {
        throw new ReclaimError('INVALID_REQUEST', 'A single close instruction does not fit in a Solana packet')
      }
      current = [item]
      continue
    }
    const trial = [...current, item]
    if (trial.length > maxCount || measure(trial) > PACKET_DATA_SIZE) {
      flush()
      if (measure([item]) > PACKET_DATA_SIZE) {
        throw new ReclaimError('INVALID_REQUEST', 'A single close instruction does not fit in a Solana packet')
      }
      current = [item]
    } else {
      current = trial
    }
  }
  flush()
  return groups
}

export function buildUnsignedReclaimTransactions(input: BuildTransactionsInput): {
  transactions: BuiltTransaction[]
  protocolFeeLamports: 0
} {
  const { priority, maxCloses, format } = assertBuildOptions(input)
  const owner = parsePubkey(input.owner, 'wallet')
  const destination = parsePubkey(input.destination ?? input.owner, 'destination')
  const allowBurn = input.allowBurn === true
  for (const target of input.targets) eligibleMode(target, allowBurn)
  const groups = packGroups(input.targets, maxCloses, (group) => (
    compileGroup(group, owner, destination, input.recentBlockhash, allowBurn, priority, format).byteLength
  ))
  return {
    protocolFeeLamports: PROTOCOL_FEE_LAMPORTS,
    transactions: groups.map((group) => compileGroup(
      group,
      owner,
      destination,
      input.recentBlockhash,
      allowBurn,
      priority,
      format,
    )),
  }
}

export function buildUnsignedLookupTableCloseTransactions(input: {
  owner: string
  destination?: string
  tables: LookupCloseTarget[]
  recentBlockhash: string
  priorityMicroLamports?: number
  format?: TxFormat
}): BuiltTransaction[] {
  const { priority, format } = assertBuildOptions(input)
  const owner = parsePubkey(input.owner, 'wallet')
  const destination = parsePubkey(input.destination ?? input.owner, 'destination')
  const compile = (tables: LookupCloseTarget[]): BuiltTransaction => {
    const closes = tables.map((table) => AddressLookupTableProgram.closeLookupTable({
      lookupTable: asPubkey(table.pubkey),
      authority: owner,
      recipient: destination,
    }))
    const instructions = [...budgetInstructions(tables.length, 0, priority), ...closes]
    const wire = serialize(instructions, owner, input.recentBlockhash, format)
    const reclaimLamports = tables.reduce((sum, table) => sum + table.lamports, 0)
    return {
      kind: 'lookup-table-close',
      format,
      base64: wire.base64,
      byteLength: wire.byteLength,
      accountPubkeys: tables.map((table) => table.pubkey),
      programIds: uniqueIds(instructions),
      reclaimLamports,
      reclaimSol: lamportsToSolString(reclaimLamports),
      instructionCount: instructions.length,
      closeCount: tables.length,
      burnCount: 0,
    }
  }
  const groups = packGroups(input.tables, 10, (group) => compile(group).byteLength)
  return groups.map(compile)
}

function emptyBuild(input: {
  wallet: string
  destination: string
  format: TxFormat
  priority: number
  warning: string
}): ReclaimBuild {
  return {
    wallet: input.wallet,
    destination: input.destination,
    recentBlockhash: '',
    lastValidBlockHeight: 0,
    priorityMicroLamports: input.priority,
    protocolFeeLamports: 0,
    format: input.format,
    totals: {
      transactions: 0,
      accounts: 0,
      closes: 0,
      burns: 0,
      reclaimLamports: 0,
      reclaimSol: '0',
      lookupTables: 0,
    },
    transactions: [],
    warnings: [input.warning],
  }
}

export async function buildReclaimFromChain(input: BuildFromChainInput): Promise<ReclaimBuild> {
  const { priority, maxCloses, format } = assertBuildOptions(input)
  const wallet = parsePubkey(input.wallet, 'wallet').toBase58()
  const destination = parsePubkey(input.destination ?? wallet, 'destination').toBase58()
  const allowBurn = input.allowBurn === true
  const accounts = input.accounts ? dedupe(input.accounts) : []
  const lookupTables = input.lookupTables ? dedupe(input.lookupTables) : []
  if (accounts.length > MAX_ACCOUNTS_PER_BUILD || lookupTables.length > 32) {
    throw new ReclaimError('INVALID_REQUEST', `Select at most ${MAX_ACCOUNTS_PER_BUILD} token accounts`)
  }
  for (const account of accounts) parsePubkey(account, 'token account')
  for (const table of lookupTables) parsePubkey(table, 'lookup table')
  if (accounts.length === 0 && lookupTables.length === 0) {
    return emptyBuild({
      wallet,
      destination,
      format,
      priority,
      warning: 'No accounts were selected.',
    })
  }

  const rpc = rpcRunner(input)
  const problems: Array<{ pubkey: string; reason: string }> = []
  const targets: CloseTarget[] = []

  if (accounts.length > 0) {
    const fetched = await mapPool(accounts, 6, async (pubkey) => {
      const response = await rpc.run(
        (connection) => connection.getParsedAccountInfo(asPubkey(pubkey), 'confirmed'),
        'getParsedAccountInfo',
      )
      return { pubkey, value: response.value }
    })
    for (const row of fetched) {
      if (!row.value) {
        problems.push({ pubkey: row.pubkey, reason: 'Account not found' })
        continue
      }
      const data = row.value.data
      if (!('parsed' in data) || data.parsed?.type !== 'account') {
        problems.push({ pubkey: row.pubkey, reason: 'Not a token account' })
        continue
      }
      const raw = normalizeRpcTokenAccount(
        row.pubkey,
        row.value.lamports,
        row.value.owner.toBase58(),
        data.parsed.info,
      )
      if (!raw) {
        problems.push({ pubkey: row.pubkey, reason: 'Token account data could not be read' })
        continue
      }
      if (raw.owner !== wallet) {
        problems.push({ pubkey: row.pubkey, reason: 'Token account belongs to a different wallet' })
        continue
      }
      const classified = classifyTokenAccount(raw, { dustUiThreshold: input.dustUiThreshold })
      const target = closeTargetFromAccount(classified)
      try {
        eligibleMode(target, allowBurn)
        targets.push(target)
      } catch (err) {
        const reason = err instanceof Error ? err.message : classified.reasons.join(' ')
        problems.push({ pubkey: row.pubkey, reason })
      }
    }
  }

  const tables: LookupCloseTarget[] = []
  if (lookupTables.length > 0) {
    const infos = await rpc.run(
      (connection) => connection.getMultipleAccountsInfo(lookupTables.map((table) => asPubkey(table)), 'confirmed'),
      'lookup tables',
    )
    const slot = BigInt(await rpc.run((connection) => connection.getSlot('confirmed'), 'getSlot'))
    lookupTables.forEach((pubkey, index) => {
      const info = infos[index]
      if (!info || info.owner.toBase58() !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID) {
        problems.push({ pubkey, reason: 'Not an address lookup table' })
        return
      }
      const decoded = decodeLookupTable(info.data)
      if (!decoded) {
        problems.push({ pubkey, reason: 'Lookup table data could not be decoded' })
        return
      }
      const status = lookupTableCloseStatus(decoded, slot, wallet)
      if (!status.closeable) {
        problems.push({ pubkey, reason: status.reason ?? 'Lookup table cannot be closed' })
        return
      }
      tables.push({ pubkey, lamports: info.lamports })
    })
  }

  if (problems.length > 0) {
    throw new ReclaimError(
      'ACCOUNT_NOT_ELIGIBLE',
      `${problems.length} account(s) cannot be closed`,
      { accounts: problems },
    )
  }
  if (targets.length === 0 && tables.length === 0) {
    return emptyBuild({ wallet, destination, format, priority, warning: 'No eligible accounts to close.' })
  }

  const latest = await rpc.run(
    (connection) => connection.getLatestBlockhash('confirmed'),
    'getLatestBlockhash',
  )
  const tokenTxs = targets.length === 0
    ? []
    : buildUnsignedReclaimTransactions({
        owner: wallet,
        destination,
        targets,
        recentBlockhash: latest.blockhash,
        allowBurn,
        priorityMicroLamports: priority,
        maxClosesPerTx: maxCloses,
        format,
      }).transactions
  const lookupTxs = tables.length === 0
    ? []
    : buildUnsignedLookupTableCloseTransactions({
        owner: wallet,
        destination,
        tables,
        recentBlockhash: latest.blockhash,
        priorityMicroLamports: priority,
        format,
      })
  const transactions = [...tokenTxs, ...lookupTxs]
  if (input.simulate) {
    for (const tx of transactions) {
      tx.simulation = await simulateBuilt(rpc, tx)
    }
  }
  const reclaimLamports = transactions.reduce((sum, tx) => sum + tx.reclaimLamports, 0)
  return {
    wallet,
    destination,
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    priorityMicroLamports: priority,
    protocolFeeLamports: 0,
    format,
    totals: {
      transactions: transactions.length,
      accounts: targets.length,
      closes: transactions.reduce((sum, tx) => sum + tx.closeCount, 0),
      burns: transactions.reduce((sum, tx) => sum + tx.burnCount, 0),
      reclaimLamports,
      reclaimSol: lamportsToSolString(reclaimLamports),
      lookupTables: tables.length,
    },
    transactions,
    warnings: [],
  }
}

async function simulateBuilt(
  rpc: ReturnType<typeof rpcRunner>,
  built: BuiltTransaction,
): Promise<SimulationResult> {
  const raw = Buffer.from(built.base64, 'base64')
  const response = await rpc.run(async (connection) => {
    const versioned = built.format === 'versioned'
      ? VersionedTransaction.deserialize(raw)
      : new VersionedTransaction(new TransactionMessage({
          payerKey: Transaction.from(raw).feePayer ?? parsePubkey(built.accountPubkeys[0] ?? '', 'account'),
          recentBlockhash: Transaction.from(raw).recentBlockhash ?? SIZE_PROBE_BLOCKHASH,
          instructions: Transaction.from(raw).instructions,
        }).compileToV0Message())
    return connection.simulateTransaction(versioned, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
    })
  }, 'simulateTransaction', 20_000)
  return {
    ok: response.value.err == null,
    err: response.value.err ? JSON.stringify(response.value.err) : null,
    unitsConsumed: response.value.unitsConsumed ?? null,
    logs: (response.value.logs ?? []).slice(0, 40),
  }
}
