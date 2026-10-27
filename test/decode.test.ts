import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { describe, expect, it } from 'vitest'
import { PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../src/core/constants.js'
import { decodeLookupTable, decodeMetaplexMetadata, lookupTableCloseStatus, readTokenAccountBase } from '../src/core/decode.js'
import { deriveCreatorFeeAccounts } from '../src/core/pdas.js'
import { parseCoingeckoPrice, parseJupiterPrice } from '../src/core/price.js'
import { MAX_U64 } from '../src/core/constants.js'
import { address, keyed } from './helpers.js'

describe('decoders', () => {
  it('decodes an address lookup table header and close cooldown', () => {
    const authority = keyed(1)
    const stored = keyed(2)
    const data = Buffer.alloc(56 + 32)
    data.writeUInt32LE(1, 0)
    data.writeBigUInt64LE(100n, 4)
    data[21] = 1
    data.set(authority.toBytes(), 22)
    data.set(stored.toBytes(), 56)
    const decoded = decodeLookupTable(data)
    expect(decoded?.authority).toBe(authority.toBase58())
    expect(decoded?.addresses).toEqual([stored.toBase58()])
    expect(decoded?.active).toBe(false)
    expect(lookupTableCloseStatus(decoded!, 700n, authority.toBase58()).closeable).toBe(true)
    expect(lookupTableCloseStatus(decoded!, 200n, authority.toBase58()).closeable).toBe(false)

    const active = Buffer.from(data)
    active.writeBigUInt64LE(MAX_U64, 4)
    const activeDecoded = decodeLookupTable(active)
    expect(activeDecoded?.active).toBe(true)
    expect(lookupTableCloseStatus(activeDecoded!, 1_000_000n, authority.toBase58()).reason).toMatch(/active/i)
  })

  it('reads the SPL token account base layout', () => {
    const mint = keyed(3)
    const owner = keyed(4)
    const data = Buffer.alloc(165)
    data.set(mint.toBytes(), 0)
    data.set(owner.toBytes(), 32)
    data.writeBigUInt64LE(42n, 64)
    expect(readTokenAccountBase(data)).toEqual({
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      amount: 42n,
    })
  })

  it('reads Metaplex name and symbol strings', () => {
    const name = 'USD Coin'
    const symbol = 'USDC'
    const uri = 'https://example.invalid/usdc.json'
    const body = Buffer.concat([
      Buffer.from([4]),
      Buffer.alloc(64),
      u32String(name),
      u32String(symbol),
      u32String(uri),
    ])
    expect(decodeMetaplexMetadata(body)).toEqual({ name, symbol, uri })
  })

  it('derives pump creator vaults with the documented seeds', () => {
    const wallet = address(1)
    const derived = deriveCreatorFeeAccounts(wallet)
    const owner = new PublicKey(wallet)
    const [pumpVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator-vault'), owner.toBuffer()],
      new PublicKey(PUMP_PROGRAM_ID),
    )
    const [swapAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator_vault'), owner.toBuffer()],
      new PublicKey(PUMP_SWAP_PROGRAM_ID),
    )
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(WSOL_MINT),
      swapAuthority,
      true,
      new PublicKey(TOKEN_PROGRAM_ID),
    )
    expect(derived.pumpCreatorVault).toBe(pumpVault.toBase58())
    expect(derived.pumpSwapCreatorAuthority).toBe(swapAuthority.toBase58())
    expect(derived.pumpSwapWsolAta).toBe(ata.toBase58())
    expect(derived.pumpCreatorVault).not.toBe(wallet)
  })
})

describe('price parsers', () => {
  it('reads CoinGecko and Jupiter payloads', () => {
    expect(parseCoingeckoPrice({ solana: { usd: 150.25 } })).toBe(150.25)
    expect(parseCoingeckoPrice({ solana: { usd: 0 } })).toBeNull()
    const mint = WSOL_MINT
    expect(parseJupiterPrice({ [mint]: { usdPrice: 151 } })).toBe(151)
    expect(parseJupiterPrice({ data: { [mint]: { price: '149.5' } } })).toBe(149.5)
  })
})

function u32String(value: string): Buffer {
  const text = Buffer.from(value)
  const out = Buffer.alloc(4 + text.length)
  out.writeUInt32LE(text.length, 0)
  text.copy(out, 4)
  return out
}
