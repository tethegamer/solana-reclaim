import type { Connection } from '@solana/web3.js'
import { RECOGNIZED_MINTS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { decodeMetaplexMetadata, metadataPda, readTokenAccountBase } from './decode.js'
import { ReclaimError, sanitizeRpcMessage } from './errors.js'
import { formatTokenAmount } from './format.js'
import { holderExclusion } from './holders.js'
import { rpcRunner } from './rpc.js'
import { assessTokenRisk, type HolderSnapshot } from './score.js'
import type { MintAudit, TokenExtension, TokenProgramKind } from './types.js'
import { asPubkey, isRecord, parsePubkey } from './util.js'

export interface AuditOptions {
  rpcUrl?: string
  connection?: Connection
}

function holderFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/indexed|personal token|largest holders failed/i.test(raw)) {
    return 'Largest holders were not available. This RPC blocks the indexed holder query. Set SOLANA_RPC_URL to an endpoint that allows getTokenLargestAccounts.'
  }
  return `Largest holders were not available (${sanitizeRpcMessage(raw) || 'RPC error'}).`
}

function readExtensions(info: Record<string, unknown>): TokenExtension[] {
  if (!Array.isArray(info.extensions)) return []
  return info.extensions.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.extension !== 'string') return []
    const ext: TokenExtension = { extension: entry.extension }
    if ('state' in entry) ext.state = entry.state
    return [ext]
  })
}

function extensionMetadata(extensions: TokenExtension[]): { name: string | null; symbol: string | null; uri: string | null } | null {
  const meta = extensions.find((item) => item.extension.toLowerCase().replace(/[^a-z]/g, '') === 'tokenmetadata')
  if (!isRecord(meta?.state)) return null
  const name = typeof meta.state.name === 'string' ? meta.state.name : null
  const symbol = typeof meta.state.symbol === 'string' ? meta.state.symbol : null
  const uri = typeof meta.state.uri === 'string' ? meta.state.uri : null
  if (!name && !symbol) return null
  return { name, symbol, uri }
}

export async function auditMint(mintAddress: string, options: AuditOptions = {}): Promise<MintAudit> {
  const started = Date.now()
  const mintKey = parsePubkey(mintAddress, 'mint')
  const mint = mintKey.toBase58()
  const rpc = rpcRunner(options)
  const warnings: string[] = []

  const [mintInfo, largest, metadataInfo] = await Promise.all([
    rpc.run((connection) => connection.getParsedAccountInfo(mintKey, 'confirmed'), 'mint account'),
    rpc.run((connection) => connection.getTokenLargestAccounts(mintKey, 'confirmed'), 'largest holders').catch((err: unknown) => {
      warnings.push(holderFailure(err))
      return null
    }),
    rpc.run(
      (connection) => connection.getAccountInfo(asPubkey(metadataPda(mint)), 'confirmed'),
      'metadata',
      8_000,
    ).catch(() => null),
  ])

  const account = mintInfo.value
  if (!account) throw new ReclaimError('NOT_FOUND', 'Mint account was not found')
  const programId = account.owner.toBase58()
  let program: TokenProgramKind
  if (programId === TOKEN_PROGRAM_ID) program = 'spl-token'
  else if (programId === TOKEN_2022_PROGRAM_ID) program = 'token-2022'
  else throw new ReclaimError('NOT_A_MINT', 'Account is not an SPL Token or Token-2022 mint')

  const data = account.data
  if (!('parsed' in data) || data.parsed?.type !== 'mint' || !isRecord(data.parsed.info)) {
    throw new ReclaimError('NOT_A_MINT', 'Account data is not a mint')
  }
  const info = data.parsed.info
  const decimals = typeof info.decimals === 'number' ? info.decimals : 0
  const supplyText = typeof info.supply === 'string' ? info.supply : '0'
  const supply = /^\d+$/.test(supplyText) ? BigInt(supplyText) : 0n
  const mintAuthority = typeof info.mintAuthority === 'string' ? info.mintAuthority : null
  const freezeAuthority = typeof info.freezeAuthority === 'string' ? info.freezeAuthority : null
  const extensions = readExtensions(info)
  const holders = await resolveHolders(rpc, mint, largest?.value ?? null, decimals, warnings)
  const recognized = mint in RECOGNIZED_MINTS
  const assessment = assessTokenRisk({
    mint,
    decimals,
    supply,
    mintAuthority,
    freezeAuthority,
    extensions,
    holders,
    recognized,
  })

  const onChainMeta = extensionMetadata(extensions)
    ?? (metadataInfo?.data ? decodeMetaplexMetadata(metadataInfo.data) : null)

  return {
    mint,
    name: onChainMeta?.name ?? null,
    symbol: onChainMeta?.symbol ?? RECOGNIZED_MINTS[mint] ?? null,
    uri: onChainMeta?.uri ?? null,
    program,
    programId,
    decimals,
    supply: supply.toString(),
    supplyUi: formatTokenAmount(supply, decimals),
    mintAuthority,
    freezeAuthority,
    recognized,
    mintLabel: RECOGNIZED_MINTS[mint] ?? null,
    extensions: assessment.extensions,
    score: assessment.score,
    concentration: assessment.concentration,
    warnings,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    rpcHost: rpc.host(),
  }
}

async function resolveHolders(
  rpc: ReturnType<typeof rpcRunner>,
  mint: string,
  largest: Array<{ address: { toBase58(): string }; amount: string }> | null,
  _decimals: number,
  warnings: string[],
): Promise<HolderSnapshot[] | null> {
  if (!largest) return null
  if (largest.length === 0) return []
  try {
    const keys = largest.map((row) => asPubkey(row.address.toBase58()))
    const infos = await rpc.run(
      (connection) => connection.getMultipleAccountsInfo(keys, 'confirmed'),
      'holder token accounts',
    )
    const bases = largest.map((row, index) => {
      const info = infos[index]
      const base = info ? readTokenAccountBase(info.data) : null
      return {
        tokenAccount: row.address.toBase58(),
        owner: base && base.mint === mint ? base.owner : null,
        amount: /^\d+$/.test(row.amount) ? BigInt(row.amount) : 0n,
      }
    })
    const ownerKeys = [...new Set(bases.flatMap((row) => row.owner ? [row.owner] : []))]
    const ownerInfos = ownerKeys.length === 0
      ? []
      : await rpc.run(
          (connection) => connection.getMultipleAccountsInfo(ownerKeys.map((owner) => asPubkey(owner)), 'confirmed'),
          'holder owners',
        )
    const ownerMeta = new Map(ownerKeys.map((owner, index) => {
      const info = ownerInfos[index]
      return [owner, {
        program: info ? info.owner.toBase58() : null,
        executable: info?.executable === true,
      }] as const
    }))
    return bases.map((row) => {
      const meta = row.owner ? ownerMeta.get(row.owner) : undefined
      const exclusion = holderExclusion({
        owner: row.owner,
        ownerProgram: meta?.program ?? null,
        ownerExecutable: meta?.executable ?? false,
      })
      return {
        tokenAccount: row.tokenAccount,
        owner: row.owner,
        amount: row.amount,
        excluded: exclusion.excluded,
        excludeReason: exclusion.reason,
      }
    })
  } catch (err) {
    warnings.push(`Holder owners could not be resolved (${err instanceof Error ? err.message : 'RPC error'}). Concentration includes every large account.`)
    return largest.map((row) => ({
      tokenAccount: row.address.toBase58(),
      owner: null,
      amount: /^\d+$/.test(row.amount) ? BigInt(row.amount) : 0n,
      excluded: false,
      excludeReason: null,
    }))
  }
}
