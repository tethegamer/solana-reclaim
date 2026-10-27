import { PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, type Connection } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/core/constants.js'
import { ReclaimError } from '../src/core/errors.js'
import {
  buildReclaimFromChain,
  buildUnsignedLookupTableCloseTransactions,
  buildUnsignedReclaimTransactions,
} from '../src/core/reclaimer.js'
import type { CloseTarget } from '../src/core/types.js'
import { address } from './helpers.js'

const OWNER = address(1)
const BLOCKHASH = address(2)

function target(byte: number, overrides: Partial<CloseTarget> = {}): CloseTarget {
  return {
    pubkey: address(byte),
    programId: TOKEN_PROGRAM_ID,
    lamports: 2_039_280,
    mint: address(200),
    amount: '0',
    decimals: 6,
    closeable: true,
    burnable: false,
    protectedMint: false,
    ...overrides,
  }
}

function legacyInstructions(base64: string): TransactionInstruction[] {
  return Transaction.from(Buffer.from(base64, 'base64')).instructions
}

describe('buildUnsignedReclaimTransactions', () => {
  it('packs 24 closes into packet-sized batches with a 20-close cap', () => {
    const targets = Array.from({ length: 24 }, (_, index) => target(10 + index))
    const built = buildUnsignedReclaimTransactions({
      owner: OWNER,
      targets,
      recentBlockhash: BLOCKHASH,
      maxClosesPerTx: 20,
    })
    expect(built.protocolFeeLamports).toBe(0)
    expect(built.transactions.length).toBeGreaterThanOrEqual(2)
    expect(built.transactions.reduce((sum, tx) => sum + tx.closeCount, 0)).toBe(24)
    expect(built.transactions[0]?.closeCount).toBe(20)
    expect(built.transactions[1]?.closeCount).toBe(4)
    for (const tx of built.transactions) {
      expect(tx.byteLength).toBeLessThanOrEqual(1232)
      expect(tx.byteLength).toBe(Buffer.from(tx.base64, 'base64').length)
      expect(tx.burnCount).toBe(0)
      expect(tx.format).toBe('legacy')
      const instructions = legacyInstructions(tx.base64)
      const closes = instructions.filter((instruction) => instruction.data.length === 1 && instruction.data[0] === 9)
      expect(closes).toHaveLength(tx.closeCount)
      expect(closes.every((instruction) => instruction.programId.toBase58() === TOKEN_PROGRAM_ID)).toBe(true)
      expect(instructions.some((instruction) => instruction.programId.equals(SystemProgram.programId))).toBe(false)
    }
  })

  it('uses the Token-2022 program id and splits mixed batches by program', () => {
    const targets = [
      target(10),
      target(11, { programId: TOKEN_2022_PROGRAM_ID }),
      target(12, { programId: TOKEN_2022_PROGRAM_ID }),
    ]
    const built = buildUnsignedReclaimTransactions({
      owner: OWNER,
      targets,
      recentBlockhash: BLOCKHASH,
      priorityMicroLamports: 0,
    })
    expect(built.transactions).toHaveLength(1)
    const closes = legacyInstructions(built.transactions[0]!.base64)
      .filter((instruction) => instruction.data[0] === 9)
    expect(closes.map((instruction) => instruction.programId.toBase58())).toEqual([
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ])
  })

  it('builds a versioned transaction that round-trips', () => {
    const built = buildUnsignedReclaimTransactions({
      owner: OWNER,
      targets: [target(10), target(11)],
      recentBlockhash: BLOCKHASH,
      format: 'versioned',
    })
    const tx = built.transactions[0]!
    expect(tx.format).toBe('versioned')
    expect(tx.byteLength).toBeLessThanOrEqual(1232)
    const decoded = VersionedTransaction.deserialize(Buffer.from(tx.base64, 'base64'))
    expect(decoded.message.compiledInstructions.length).toBeGreaterThanOrEqual(3)
    expect(decoded.signatures[0]?.every((byte) => byte === 0)).toBe(true)
  })

  it('burns unprotected dust only when allowBurn is set', () => {
    const dust = target(10, {
      amount: '1000',
      closeable: false,
      burnable: true,
      mint: address(80),
    })
    expect(() => buildUnsignedReclaimTransactions({
      owner: OWNER,
      targets: [dust],
      recentBlockhash: BLOCKHASH,
    })).toThrow(ReclaimError)

    const built = buildUnsignedReclaimTransactions({
      owner: OWNER,
      targets: [dust],
      recentBlockhash: BLOCKHASH,
      allowBurn: true,
      priorityMicroLamports: 0,
    })
    const instructions = legacyInstructions(built.transactions[0]!.base64)
    const burn = instructions.find((instruction) => instruction.data[0] === 8)
    const close = instructions.find((instruction) => instruction.data[0] === 9)
    expect(burn?.programId.toBase58()).toBe(TOKEN_PROGRAM_ID)
    expect(close?.programId.toBase58()).toBe(TOKEN_PROGRAM_ID)
    expect(built.transactions[0]?.burnCount).toBe(1)
  })

  it('refuses to burn a recognized mint', () => {
    const usdc = target(10, {
      amount: '5',
      closeable: false,
      burnable: false,
      protectedMint: true,
    })
    expect(() => buildUnsignedReclaimTransactions({
      owner: OWNER,
      targets: [usdc],
      recentBlockhash: BLOCKHASH,
      allowBurn: true,
    })).toThrow(/recognized mint/i)
  })

  it('is deterministic for the same inputs', () => {
    const input = {
      owner: OWNER,
      targets: [target(10), target(11), target(12)],
      recentBlockhash: BLOCKHASH,
      priorityMicroLamports: 15_000,
    }
    const first = buildUnsignedReclaimTransactions(input)
    const second = buildUnsignedReclaimTransactions(input)
    expect(first.transactions[0]?.base64).toBe(second.transactions[0]?.base64)
  })

  it('closes lookup tables with the ALT program', () => {
    const [tx] = buildUnsignedLookupTableCloseTransactions({
      owner: OWNER,
      tables: [{ pubkey: address(40), lamports: 1_000_000 }],
      recentBlockhash: BLOCKHASH,
      priorityMicroLamports: 0,
    })
    expect(tx?.kind).toBe('lookup-table-close')
    expect(tx?.byteLength).toBeLessThanOrEqual(1232)
    const close = legacyInstructions(tx!.base64).find((instruction) => instruction.data.length === 4)
    expect(close?.programId.toBase58()).toBe('AddressLookupTab1e1111111111111111111111111')
    expect(close?.data.readUInt32LE(0)).toBe(4)
    expect(close?.keys.map((key) => key.pubkey.toBase58())).toEqual([address(40), OWNER, OWNER])
  })

  it('re-reads chain state and refuses a non-empty account', async () => {
    const account = address(10)
    await expect(buildReclaimFromChain({
      wallet: OWNER,
      accounts: [account],
      connection: fakeChain(account, '25') as unknown as Connection,
    })).rejects.toThrow(/cannot be closed/i)
  })

  it('builds from a zero-balance account fetched off a connection', async () => {
    const account = address(10)
    const built = await buildReclaimFromChain({
      wallet: OWNER,
      accounts: [account],
      connection: fakeChain(account, '0') as unknown as Connection,
      priorityMicroLamports: 0,
    })
    expect(built.protocolFeeLamports).toBe(0)
    expect(built.recentBlockhash).toBe(BLOCKHASH)
    expect(built.totals.closes).toBe(1)
    expect(built.transactions[0]?.base64.length).toBeGreaterThan(20)
  })
})

function fakeChain(account: string, amount: string): Partial<Connection> {
  return {
    rpcEndpoint: 'https://rpc.test',
    async getParsedAccountInfo() {
      return {
        context: { slot: 1 },
        value: {
          lamports: 2_039_280,
          owner: new PublicKey(TOKEN_PROGRAM_ID),
          executable: false,
          rentEpoch: 0,
          data: {
            program: 'spl-token',
            parsed: {
              type: 'account',
              info: {
                mint: address(20),
                owner: OWNER,
                state: 'initialized',
                isNative: false,
                tokenAmount: { amount, decimals: 6, uiAmount: amount === '0' ? 0 : 0.000025, uiAmountString: amount },
              },
            },
            space: 165,
          },
        },
      } as unknown as Awaited<ReturnType<Connection['getParsedAccountInfo']>>
    },
    async getLatestBlockhash() {
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 99 }
    },
  }
}
