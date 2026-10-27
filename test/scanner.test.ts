import { PublicKey, type Connection } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { TOKEN_PROGRAM_ID, USDC_MINT } from '../src/core/constants.js'
import { scanWallet } from '../src/core/scanner.js'
import { address, keyed } from './helpers.js'

describe('scanWallet', () => {
  it('classifies parsed token accounts without a live RPC', async () => {
    const wallet = keyed(1)
    const empty = keyed(10)
    const frozen = keyed(11)
    const splProgram = new PublicKey(TOKEN_PROGRAM_ID)
    const rows = [
      tokenRow(empty, splProgram, 2_039_280, {
        mint: USDC_MINT,
        owner: wallet.toBase58(),
        state: 'initialized',
        isNative: false,
        tokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
      }),
      tokenRow(frozen, splProgram, 2_039_280, {
        mint: address(21),
        owner: wallet.toBase58(),
        state: 'frozen',
        isNative: false,
        tokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
      }),
    ]
    const connection = {
      rpcEndpoint: 'https://api.mainnet-beta.solana.com',
      getBalance: async () => 1_500_000_000,
      getParsedTokenAccountsByOwner: async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
        value: filter.programId.equals(splProgram) ? rows : [],
      }),
      getSignaturesForAddress: async () => [],
      getMultipleAccountsInfo: async () => [null, null],
      getProgramAccounts: async () => {
        throw new Error('excluded from account secondary indexes')
      },
    }
    const scan = await scanWallet(wallet.toBase58(), {
      connection: connection as unknown as Connection,
      price: { usd: 100, source: 'test' },
    })
    expect(JSON.parse(JSON.stringify(scan)).address).toBe(wallet.toBase58())
    expect(scan.nativeSol).toBe('1.5')
    expect(scan.nativeUsd).toBe(150)
    expect(scan.summary.emptySpl).toBe(1)
    expect(scan.summary.locked).toBe(1)
    expect(scan.reclaimableLamports).toBe(2_039_280)
    expect(scan.reclaimableSol).toBe('0.00203928')
    expect(scan.reclaimableUsd).toBeCloseTo(0.203928, 6)
    expect(scan.summary.estimatedCloseTransactions).toBe(1)
    expect(scan.activity.lookupTables.status).toBe('unavailable')
    expect(scan.activity.creatorFees.pumpCreatorVault.exists).toBe(false)
    expect(scan.accounts[0]?.category).toBe('reclaimable')
    expect(scan.accounts[0]?.mintLabel).toBe('USDC')
  })
})

function tokenRow(pubkey: PublicKey, program: PublicKey, lamports: number, info: Record<string, unknown>) {
  return {
    pubkey,
    account: {
      lamports,
      owner: program,
      data: { parsed: { type: 'account', info } },
    },
  }
}
