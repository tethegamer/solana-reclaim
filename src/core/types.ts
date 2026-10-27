export type AccountCategory = 'reclaimable' | 'dust' | 'active' | 'locked'
export type TokenProgramKind = 'spl-token' | 'token-2022' | 'unknown'
export type TxFormat = 'legacy' | 'versioned'
export type TxKind = 'token-close' | 'lookup-table-close'

export interface TokenExtension {
  extension: string
  state?: unknown
}

export interface RawTokenAccount {
  pubkey: string
  programId: string
  lamports: number
  mint: string
  owner: string
  state: string
  amount: string
  decimals: number
  uiAmount: number | null
  uiAmountString: string
  extensions: TokenExtension[]
  isNative: boolean
}

export interface ClassifiedAccount extends RawTokenAccount {
  program: TokenProgramKind
  category: AccountCategory
  closeable: boolean
  burnable: boolean
  protectedMint: boolean
  mintLabel: string | null
  withheldAmount: string
  reasonCodes: string[]
  reasons: string[]
  reclaimLamports: number
  potentialRentLamports: number
  stuckLamports: number
}

export interface AccountSummary {
  tokenAccounts: number
  emptySpl: number
  emptyToken2022: number
  dust: number
  active: number
  locked: number
  reclaimableAccounts: number
  estimatedCloseTransactions: number
}

export interface ProgramTouch {
  id: string
  name: string
  kind: string
  hits: number
}

export interface LookupTableSurface {
  address: string
  lamports: number
  sol: string
  addressesStored: number
  active: boolean
  closeable: boolean
  authority: string | null
  deactivationSlot: string
  reason: string | null
}

export interface LookupTableScan {
  status: 'ok' | 'unavailable'
  detail: string | null
  tables: LookupTableSurface[]
  reclaimableLamports: number
  reclaimableSol: string
}

export interface PumpVaultSurface {
  address: string
  exists: boolean
  owner: string | null
  lamports: number
  claimableLamports: number
  claimableSol: string
}

export interface PumpSwapFeeSurface {
  address: string
  authority: string
  exists: boolean
  amount: string
  uiAmount: string
  rentLamports: number
  mintMatches: boolean
}

export interface CreatorFeeSurface {
  note: string
  pumpCreatorVault: PumpVaultSurface
  pumpSwapWsolAta: PumpSwapFeeSurface
}

export interface WalletActivity {
  signaturesConsidered: number
  transactionsSampled: number
  programs: ProgramTouch[]
  lookupTables: LookupTableScan
  creatorFees: CreatorFeeSurface
}

export interface WalletScan {
  address: string
  nativeLamports: number
  nativeSol: string
  nativeUsd: number | null
  solPriceUsd: number | null
  solPriceSource: string | null
  reclaimableLamports: number
  reclaimableSol: string
  reclaimableUsd: number | null
  dustRentLamports: number
  dustRentSol: string
  stuckLamports: number
  accounts: ClassifiedAccount[]
  summary: AccountSummary
  activity: WalletActivity
  warnings: string[]
  scannedAt: string
  durationMs: number
  rpcHost: string | null
}

export interface ScanBatch {
  wallets: WalletScan[]
  errors: Array<{ address: string; error: string; code: string }>
  solPriceUsd: number | null
  solPriceSource: string | null
  durationMs: number
  rpcHost: string | null
}

export interface CloseTarget {
  pubkey: string
  programId: string
  lamports: number
  mint: string
  amount: string
  decimals: number
  closeable: boolean
  burnable: boolean
  protectedMint: boolean
}

export interface LookupCloseTarget {
  pubkey: string
  lamports: number
}

export interface SimulationResult {
  ok: boolean
  err: string | null
  unitsConsumed: number | null
  logs: string[]
}

export interface BuiltTransaction {
  kind: TxKind
  format: TxFormat
  base64: string
  byteLength: number
  accountPubkeys: string[]
  programIds: string[]
  reclaimLamports: number
  reclaimSol: string
  instructionCount: number
  closeCount: number
  burnCount: number
  simulation?: SimulationResult
}

export interface ReclaimTotals {
  transactions: number
  accounts: number
  closes: number
  burns: number
  reclaimLamports: number
  reclaimSol: string
  lookupTables: number
}

export interface ReclaimBuild {
  wallet: string
  destination: string
  recentBlockhash: string
  lastValidBlockHeight: number
  priorityMicroLamports: number
  protocolFeeLamports: 0
  format: TxFormat
  totals: ReclaimTotals
  transactions: BuiltTransaction[]
  warnings: string[]
}

export interface ExtensionFinding {
  name: string
  risk: 'danger' | 'warn' | 'info'
  summary: string
}

export interface ScoreBreakdownItem {
  code: string
  label: string
  delta: number
  detail: string
}

export interface RiskBadge {
  tone: 'good' | 'warn' | 'bad' | 'info'
  label: string
}

export type ScoreBand = 'lower-risk' | 'mixed' | 'elevated' | 'high-risk'

export interface SafetyScore {
  composite: number
  authority: number
  distribution: number | null
  band: ScoreBand
  bandLabel: string
  criticalCap: boolean
  protectedFloor: boolean
  breakdown: ScoreBreakdownItem[]
  badges: RiskBadge[]
  summary: string
}

export interface HolderRow {
  rank: number
  tokenAccount: string
  owner: string | null
  amount: string
  amountUi: string
  supplyPct: number | null
  excluded: boolean
  excludeReason: string | null
}

export interface ConcentrationReport {
  available: boolean
  sampleSize: number
  excludedCount: number
  lpSharePct: number | null
  circulatingTop1Pct: number | null
  circulatingTop5Pct: number | null
  circulatingTop10Pct: number | null
  rawTop1Pct: number | null
  rawTop10Pct: number | null
  note: string
  holders: HolderRow[]
}

export interface MintAudit {
  mint: string
  name: string | null
  symbol: string | null
  uri: string | null
  program: TokenProgramKind
  programId: string
  decimals: number
  supply: string
  supplyUi: string
  mintAuthority: string | null
  freezeAuthority: string | null
  recognized: boolean
  mintLabel: string | null
  extensions: ExtensionFinding[]
  score: SafetyScore
  concentration: ConcentrationReport
  warnings: string[]
  scannedAt: string
  durationMs: number
  rpcHost: string | null
}

export interface SolPrice {
  usd: number | null
  source: string | null
}
