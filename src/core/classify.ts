import { RECOGNIZED_MINTS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, DEFAULT_DUST_UI_THRESHOLD } from './constants.js'
import { ReclaimError } from './errors.js'
import type { ClassifiedAccount, RawTokenAccount, TokenExtension, TokenProgramKind } from './types.js'
import { asBigInt, isRecord } from './util.js'

export interface ClassifyOptions {
  dustUiThreshold?: number
}

function programKind(programId: string): TokenProgramKind {
  if (programId === TOKEN_PROGRAM_ID) return 'spl-token'
  if (programId === TOKEN_2022_PROGRAM_ID) return 'token-2022'
  return 'unknown'
}

function parseAmount(amount: string): bigint | null {
  if (!/^\d+$/.test(amount)) return null
  try {
    return BigInt(amount)
  } catch {
    return null
  }
}

function withheldAmount(extensions: TokenExtension[]): bigint {
  let total = 0n
  for (const ext of extensions) {
    const name = ext.extension.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (name !== 'transferfeeamount') continue
    if (!isRecord(ext.state) || !('withheldAmount' in ext.state)) return 1n
    total += asBigInt(ext.state.withheldAmount)
  }
  return total
}

function confidentialBlocks(extensions: TokenExtension[]): boolean {
  const balanceKeys = ['pendingBalance', 'availableBalance', 'withheldAmount', 'decryptableAvailableBalance']
  for (const ext of extensions) {
    if (!ext.extension.toLowerCase().includes('confidential')) continue
    if (!isRecord(ext.state)) return true
    let saw = false
    for (const key of balanceKeys) {
      if (!(key in ext.state)) continue
      saw = true
      if (asBigInt(ext.state[key]) > 0n) return true
    }
    if (!saw) return true
  }
  return false
}

function belowDust(raw: RawTokenAccount, amount: bigint, threshold: number): boolean {
  if (amount <= 0n) return false
  if (raw.uiAmount != null && Number.isFinite(raw.uiAmount)) return raw.uiAmount < threshold
  if (!Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 18) return false
  const scale = 10n ** BigInt(raw.decimals)
  const thresholdMicro = BigInt(Math.round(threshold * 1_000_000))
  return amount * 1_000_000n < thresholdMicro * scale
}

export function classifyTokenAccount(raw: RawTokenAccount, options: ClassifyOptions = {}): ClassifiedAccount {
  const threshold = options.dustUiThreshold ?? DEFAULT_DUST_UI_THRESHOLD
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new ReclaimError('INVALID_REQUEST', 'dustUiThreshold must be a non-negative number')
  }

  const program = programKind(raw.programId)
  const lamports = Number.isSafeInteger(raw.lamports) && raw.lamports > 0 ? raw.lamports : 0
  const amount = parseAmount(raw.amount)
  const protectedMint = raw.mint in RECOGNIZED_MINTS
  const mintLabel = RECOGNIZED_MINTS[raw.mint] ?? null
  const withheld = withheldAmount(raw.extensions)
  const reasonCodes: string[] = []
  const reasons: string[] = []

  const base = {
    ...raw,
    lamports,
    program,
    protectedMint,
    mintLabel,
    withheldAmount: withheld.toString(),
    reasonCodes,
    reasons,
    closeable: false,
    burnable: false,
    category: 'locked' as const,
    reclaimLamports: 0,
    potentialRentLamports: 0,
    stuckLamports: lamports,
  }

  if (program === 'unknown') {
    reasonCodes.push('unsupported-program')
    reasons.push('Account is not owned by the SPL Token or Token-2022 program.')
    return base
  }
  if (amount == null) {
    reasonCodes.push('unreadable-balance')
    reasons.push('Token balance could not be read, so the account was left untouched.')
    return base
  }

  const state = raw.state.toLowerCase()
  const frozen = state === 'frozen'
  const uninitialized = state === 'uninitialized'
  const confidential = confidentialBlocks(raw.extensions)
  const blocked = frozen || uninitialized || withheld > 0n || confidential

  if (frozen) {
    reasonCodes.push('frozen')
    reasons.push('Frozen. The freeze authority has to thaw this account before it can be closed.')
  }
  if (uninitialized) {
    reasonCodes.push('uninitialized')
    reasons.push('Account is not initialized, so closeAccount is not used.')
  }
  if (withheld > 0n) {
    reasonCodes.push('withheld-fees')
    reasons.push('Unharvested Token-2022 withheld transfer fees block closeAccount.')
  }
  if (confidential) {
    reasonCodes.push('confidential')
    reasons.push('Confidential-transfer state is present and not proven empty.')
  }

  if (amount === 0n && !blocked) {
    reasonCodes.push('reclaimable-empty')
    reasons.push('Zero balance. Rent can be reclaimed with closeAccount.')
    return {
      ...base,
      category: 'reclaimable',
      closeable: true,
      burnable: false,
      reclaimLamports: lamports,
      potentialRentLamports: lamports,
      stuckLamports: 0,
    }
  }

  if (blocked) {
    if (amount > 0n) {
      reasonCodes.push('non-zero')
      reasons.push('Balance is not zero.')
    }
    return base
  }

  if (protectedMint) {
    reasonCodes.push('protected-balance')
    reasons.push(`${mintLabel ?? 'Recognized mint'} still has a balance, so it is not offered for burning.`)
    return {
      ...base,
      category: 'active',
      stuckLamports: 0,
    }
  }

  if (belowDust(raw, amount, threshold)) {
    reasonCodes.push('dust')
    reasons.push('Balance is under the dust threshold. Burning it is optional, off by default, and irreversible.')
    return {
      ...base,
      category: 'dust',
      burnable: true,
      potentialRentLamports: lamports,
      stuckLamports: 0,
    }
  }

  reasonCodes.push('active-balance')
  reasons.push('Balance is at or above the dust threshold, so it is left in place.')
  return {
    ...base,
    category: 'active',
    stuckLamports: 0,
  }
}

export function normalizeRpcTokenAccount(
  pubkey: string,
  lamports: number,
  programId: string,
  info: unknown,
): RawTokenAccount | null {
  if (!isRecord(info)) return null
  const tokenAmount = isRecord(info.tokenAmount) ? info.tokenAmount : null
  if (!tokenAmount || typeof tokenAmount.amount !== 'string') return null
  const mint = typeof info.mint === 'string' ? info.mint : null
  const owner = typeof info.owner === 'string' ? info.owner : null
  if (!mint || !owner) return null
  const decimals = typeof tokenAmount.decimals === 'number' ? tokenAmount.decimals : 0
  const uiAmount = typeof tokenAmount.uiAmount === 'number' && Number.isFinite(tokenAmount.uiAmount)
    ? tokenAmount.uiAmount
    : null
  const uiAmountString = typeof tokenAmount.uiAmountString === 'string'
    ? tokenAmount.uiAmountString
    : uiAmount == null
      ? tokenAmount.amount
      : String(uiAmount)
  const extensions = Array.isArray(info.extensions)
    ? info.extensions.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.extension !== 'string') return []
        const ext: TokenExtension = { extension: entry.extension }
        if ('state' in entry) ext.state = entry.state
        return [ext]
      })
    : []
  const isNative = info.isNative === true || typeof info.isNative === 'number'
  return {
    pubkey,
    programId,
    lamports,
    mint,
    owner,
    state: typeof info.state === 'string' ? info.state : 'initialized',
    amount: tokenAmount.amount,
    decimals,
    uiAmount,
    uiAmountString,
    extensions,
    isNative,
  }
}
