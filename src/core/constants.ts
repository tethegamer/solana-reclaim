import { PublicKey } from '@solana/web3.js'

function id(value: string, label: string): string {
  try {
    return new PublicKey(value).toBase58()
  } catch {
    throw new Error(`Invalid pubkey constant ${label}`)
  }
}

export const TOKEN_PROGRAM_ID = id('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'spl-token')
export const TOKEN_2022_PROGRAM_ID = id('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'token-2022')
export const ASSOCIATED_TOKEN_PROGRAM_ID = id('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ata')
export const SYSTEM_PROGRAM_ID = id('11111111111111111111111111111111', 'system')
export const COMPUTE_BUDGET_PROGRAM_ID = id('ComputeBudget111111111111111111111111111111', 'compute-budget')
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = id(
  'AddressLookupTab1e1111111111111111111111111',
  'alt',
)
export const METAPLEX_METADATA_PROGRAM_ID = id('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'metaplex')

export const PUMP_PROGRAM_ID = id('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pump')
export const PUMP_SWAP_PROGRAM_ID = id('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'pumpswap')
export const PUMP_FEES_PROGRAM_ID = id('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', 'pump-fees')

export const RAYDIUM_AMM_V4 = id('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'raydium-amm')
export const RAYDIUM_CPMM = id('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'raydium-cpmm')
export const RAYDIUM_CLMM = id('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'raydium-clmm')
export const RAYDIUM_AUTHORITY_V4 = id('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'raydium-authority')

export const METEORA_DLMM = id('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'meteora-dlmm')
export const METEORA_POOLS = id('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', 'meteora-pools')
export const ORCA_WHIRLPOOL = id('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'orca')

export const JITO_TIP_PAYMENT = id('T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt', 'jito-tip-payment')
export const JITO_TIP_DISTRIBUTION = id('4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7', 'jito-tip-distribution')
export const JUPITER_V6 = id('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'jupiter-v6')

export const WSOL_MINT = id('So11111111111111111111111111111111111111112', 'wsol')
export const USDC_MINT = id('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'usdc')
export const USDT_MINT = id('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'usdt')
export const PYUSD_MINT = id('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 'pyusd')
export const MSOL_MINT = id('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'msol')
export const JITOSOL_MINT = id('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'jitosol')
export const BSOL_MINT = id('bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', 'bsol')
export const JUP_MINT = id('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'jup')
export const RAY_MINT = id('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'ray')
export const BONK_MINT = id('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'bonk')
export const WIF_MINT = id('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'wif')
export const PYTH_MINT = id('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'pyth')
export const JTO_MINT = id('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', 'jto')
export const RENDER_MINT = id('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', 'render')

/** Mints that are never offered for burning, even when the balance is under 1 token. */
export const RECOGNIZED_MINTS: Record<string, string> = {
  [WSOL_MINT]: 'wSOL',
  [USDC_MINT]: 'USDC',
  [USDT_MINT]: 'USDT',
  [PYUSD_MINT]: 'PYUSD',
  [MSOL_MINT]: 'mSOL',
  [JITOSOL_MINT]: 'jitoSOL',
  [BSOL_MINT]: 'bSOL',
  [JUP_MINT]: 'JUP',
  [RAY_MINT]: 'RAY',
  [BONK_MINT]: 'BONK',
  [WIF_MINT]: 'WIF',
  [PYTH_MINT]: 'PYTH',
  [JTO_MINT]: 'JTO',
  [RENDER_MINT]: 'RENDER',
}

export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
/** Public endpoints tried after the official RPC rejects a method (indexed holders, 429, 403). */
export const PUBLIC_FALLBACK_RPC_URLS = [
  'https://public.rpc.solanavibestation.com',
  'https://solana-rpc.publicnode.com',
] as const
export const PUBLIC_FALLBACK_RPC_URL = PUBLIC_FALLBACK_RPC_URLS[0]

export const PACKET_DATA_SIZE = 1232
export const DEFAULT_MAX_CLOSES_PER_TX = 20
export const MAX_CLOSES_PER_TX = 24
export const DEFAULT_PRIORITY_MICRO_LAMPORTS = 20_000
export const MAX_PRIORITY_MICRO_LAMPORTS = 1_000_000
export const PROTOCOL_FEE_LAMPORTS = 0
export const ALT_CLOSE_COOLDOWN_SLOTS = 513n
export const MAX_U64 = (1n << 64n) - 1n
export const DEFAULT_DUST_UI_THRESHOLD = 1
export const MAX_WALLETS_PER_SCAN = 10
export const MAX_ACCOUNTS_PER_BUILD = 128

export const IGNORED_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  id('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'memo-v2'),
  id('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'memo-v1'),
])

/** Programs whose PDAs commonly custody LP or bonding-curve token accounts. */
export const VAULT_PROGRAM_IDS = new Set([
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
  RAYDIUM_CLMM,
  METEORA_DLMM,
  METEORA_POOLS,
  ORCA_WHIRLPOOL,
  PUMP_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
])

export const VAULT_OWNER_IDS = new Set([RAYDIUM_AUTHORITY_V4])

export const BURN_OWNER_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  id('1nc1nerator11111111111111111111111111111111', 'incinerator'),
])

export interface KnownProgram {
  id: string
  name: string
  kind: 'amm' | 'launchpad' | 'mev' | 'infra' | 'aggregator' | 'fees'
}

export const KNOWN_PROGRAMS: KnownProgram[] = [
  { id: PUMP_PROGRAM_ID, name: 'pump.fun', kind: 'launchpad' },
  { id: PUMP_SWAP_PROGRAM_ID, name: 'PumpSwap', kind: 'amm' },
  { id: PUMP_FEES_PROGRAM_ID, name: 'Pump Fees', kind: 'fees' },
  { id: RAYDIUM_AMM_V4, name: 'Raydium AMM v4', kind: 'amm' },
  { id: RAYDIUM_CPMM, name: 'Raydium CPMM', kind: 'amm' },
  { id: RAYDIUM_CLMM, name: 'Raydium CLMM', kind: 'amm' },
  { id: METEORA_DLMM, name: 'Meteora DLMM', kind: 'amm' },
  { id: METEORA_POOLS, name: 'Meteora Pools', kind: 'amm' },
  { id: ORCA_WHIRLPOOL, name: 'Orca Whirlpool', kind: 'amm' },
  { id: JITO_TIP_PAYMENT, name: 'Jito tip payment', kind: 'mev' },
  { id: JITO_TIP_DISTRIBUTION, name: 'Jito tip distribution', kind: 'mev' },
  { id: JUPITER_V6, name: 'Jupiter v6', kind: 'aggregator' },
  { id: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, name: 'Address Lookup Table', kind: 'infra' },
]

export const PROGRAM_BY_ID = new Map(KNOWN_PROGRAMS.map((program) => [program.id, program]))

/** Cooker, a public pump.fun wallet used as the default scan preset. */
export const DEMO_WALLET = '8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6'

export const SCORE_MODEL_SUMMARY =
  'The composite safety score is the average of an authority/extension score and a holder-distribution score, from 0 to 100. ' +
  'Active mint authority, freeze authority, a permanent delegate, a transfer hook, non-transferable mode, a frozen default account state, and high transfer fees lower the authority score. ' +
  'Top-holder percentages are computed after removing burn addresses and accounts owned by known LP or launchpad programs, and they lower the distribution score. ' +
  'A critical extension caps the composite at 45. Recognized issuer mints such as USDC keep their authority flags visible, but issuer mint/freeze control is scored as expected and the composite is floored at 88 when no critical extension is present.'
