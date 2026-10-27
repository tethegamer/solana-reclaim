import { describe, expect, it } from 'vitest'
import { classifyTokenAccount, normalizeRpcTokenAccount } from '../src/core/classify.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT } from '../src/core/constants.js'
import { lamportsToSolString } from '../src/core/format.js'
import { rentExemptLamports, STANDARD_TOKEN_RENT_LAMPORTS, ZERO_DATA_RENT_LAMPORTS } from '../src/core/rent.js'
import type { RawTokenAccount } from '../src/core/types.js'
import { address } from './helpers.js'

const RENT = 2_039_280

function raw(overrides: Partial<RawTokenAccount> = {}): RawTokenAccount {
  return {
    pubkey: address(10),
    programId: TOKEN_PROGRAM_ID,
    lamports: RENT,
    mint: address(20),
    owner: address(1),
    state: 'initialized',
    amount: '0',
    decimals: 6,
    uiAmount: 0,
    uiAmountString: '0',
    extensions: [],
    isNative: false,
    ...overrides,
  }
}

describe('rent math', () => {
  it('matches the standard 165-byte token account exemption', () => {
    expect(STANDARD_TOKEN_RENT_LAMPORTS).toBe(2_039_280)
    expect(rentExemptLamports(165)).toBe(2_039_280)
    expect(ZERO_DATA_RENT_LAMPORTS).toBe(890_880)
    expect(lamportsToSolString(2_039_280)).toBe('0.00203928')
    expect(lamportsToSolString(1_000_000_000)).toBe('1')
    expect(lamportsToSolString(1_500_000_000)).toBe('1.5')
  })
})

describe('classifyTokenAccount', () => {
  it('marks an empty SPL account reclaimable for its exact lamports', () => {
    const account = classifyTokenAccount(raw())
    expect(account.category).toBe('reclaimable')
    expect(account.closeable).toBe(true)
    expect(account.burnable).toBe(false)
    expect(account.reclaimLamports).toBe(RENT)
    expect(account.reasonCodes).toContain('reclaimable-empty')
    expect(account.program).toBe('spl-token')
  })

  it('marks an empty Token-2022 account reclaimable and keeps the larger rent', () => {
    const account = classifyTokenAccount(raw({
      programId: TOKEN_2022_PROGRAM_ID,
      lamports: 2_500_000,
      extensions: [{ extension: 'immutableOwner' }],
    }))
    expect(account.program).toBe('token-2022')
    expect(account.category).toBe('reclaimable')
    expect(account.reclaimLamports).toBe(2_500_000)
  })

  it('does not close a non-zero account', () => {
    const account = classifyTokenAccount(raw({ amount: '1000', uiAmount: 0.001, uiAmountString: '0.001' }))
    expect(account.category).toBe('dust')
    expect(account.closeable).toBe(false)
    expect(account.burnable).toBe(true)
    expect(account.reclaimLamports).toBe(0)
    expect(account.potentialRentLamports).toBe(RENT)
  })

  it('locks frozen empty accounts', () => {
    const account = classifyTokenAccount(raw({ state: 'frozen' }))
    expect(account.category).toBe('locked')
    expect(account.closeable).toBe(false)
    expect(account.reasonCodes).toContain('frozen')
  })

  it('locks Token-2022 accounts with withheld fees', () => {
    const account = classifyTokenAccount(raw({
      programId: TOKEN_2022_PROGRAM_ID,
      extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: '15' } }],
    }))
    expect(account.category).toBe('locked')
    expect(account.reasonCodes).toContain('withheld-fees')
    expect(account.withheldAmount).toBe('15')
  })

  it('allows close when withheld fees are zero', () => {
    const account = classifyTokenAccount(raw({
      programId: TOKEN_2022_PROGRAM_ID,
      extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: 0 } }],
    }))
    expect(account.category).toBe('reclaimable')
  })

  it('protects recognized mints from the dust burner but still closes empty ones', () => {
    const empty = classifyTokenAccount(raw({ mint: USDC_MINT, amount: '0', uiAmount: 0 }))
    expect(empty.category).toBe('reclaimable')
    expect(empty.mintLabel).toBe('USDC')

    const dust = classifyTokenAccount(raw({
      mint: USDC_MINT,
      amount: '500000',
      uiAmount: 0.5,
      uiAmountString: '0.5',
    }))
    expect(dust.category).toBe('active')
    expect(dust.burnable).toBe(false)
    expect(dust.protectedMint).toBe(true)
    expect(dust.reasonCodes).toContain('protected-balance')
  })

  it('keeps balances at or above one whole token active', () => {
    const account = classifyTokenAccount(raw({
      amount: '1000000',
      uiAmount: 1,
      uiAmountString: '1',
    }))
    expect(account.category).toBe('active')
    expect(account.burnable).toBe(false)
  })

  it('normalizes parsed RPC account data', () => {
    const normalized = normalizeRpcTokenAccount(address(10), RENT, TOKEN_PROGRAM_ID, {
      mint: USDC_MINT,
      owner: address(1),
      state: 'initialized',
      isNative: false,
      tokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
    })
    expect(normalized?.mint).toBe(USDC_MINT)
    expect(classifyTokenAccount(normalized!).category).toBe('reclaimable')
  })
})
