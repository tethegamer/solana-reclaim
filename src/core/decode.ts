import { PublicKey } from '@solana/web3.js'
import { ALT_CLOSE_COOLDOWN_SLOTS, MAX_U64, METAPLEX_METADATA_PROGRAM_ID } from './constants.js'
import { asPubkey } from './util.js'

export interface DecodedLookupTable {
  deactivationSlot: bigint
  active: boolean
  authority: string | null
  addresses: string[]
}

export function decodeLookupTable(data: Uint8Array): DecodedLookupTable | null {
  if (data.length < 56) return null
  const buf = Buffer.from(data)
  const type = buf.readUInt32LE(0)
  if (type !== 1) return null
  const deactivationSlot = buf.readBigUInt64LE(4)
  const hasAuthority = buf[21] === 1
  let authority: string | null = null
  if (hasAuthority) {
    try {
      authority = new PublicKey(buf.subarray(22, 54)).toBase58()
    } catch {
      return null
    }
  }
  const addresses: string[] = []
  for (let offset = 56; offset + 32 <= buf.length; offset += 32) {
    try {
      addresses.push(new PublicKey(buf.subarray(offset, offset + 32)).toBase58())
    } catch {
      return null
    }
  }
  return {
    deactivationSlot,
    active: deactivationSlot === MAX_U64,
    authority,
    addresses,
  }
}

export function lookupTableCloseStatus(
  table: DecodedLookupTable,
  currentSlot: bigint,
  wallet: string,
): { closeable: boolean; reason: string | null } {
  if (table.authority == null) {
    return { closeable: false, reason: 'Lookup table is frozen (no authority).' }
  }
  if (table.authority !== wallet) {
    return { closeable: false, reason: 'Lookup table authority is a different wallet.' }
  }
  if (table.active) {
    return { closeable: false, reason: 'Lookup table is still active. Deactivate it, then wait 513 slots.' }
  }
  if (currentSlot <= table.deactivationSlot + ALT_CLOSE_COOLDOWN_SLOTS) {
    return { closeable: false, reason: 'Lookup table is deactivated and still inside the 513-slot cooldown.' }
  }
  return { closeable: true, reason: null }
}

export interface TokenAccountBase {
  mint: string
  owner: string
  amount: bigint
}

export function readTokenAccountBase(data: Uint8Array): TokenAccountBase | null {
  if (data.length < 72) return null
  try {
    const buf = Buffer.from(data)
    return {
      mint: new PublicKey(buf.subarray(0, 32)).toBase58(),
      owner: new PublicKey(buf.subarray(32, 64)).toBase58(),
      amount: buf.readBigUInt64LE(64),
    }
  } catch {
    return null
  }
}

export interface MetaplexName {
  name: string
  symbol: string
  uri: string
}

function readBorshString(buf: Buffer, offset: number, max: number): { value: string; offset: number } | null {
  if (offset + 4 > buf.length) return null
  const length = buf.readUInt32LE(offset)
  if (length > max || offset + 4 + length > buf.length) return null
  const value = buf.subarray(offset + 4, offset + 4 + length).toString('utf8').replace(/\0/g, '').trim()
  return { value, offset: offset + 4 + length }
}

export function decodeMetaplexMetadata(data: Uint8Array): MetaplexName | null {
  if (data.length < 70 || data[0] !== 4) return null
  const buf = Buffer.from(data)
  const name = readBorshString(buf, 65, 200)
  if (!name) return null
  const symbol = readBorshString(buf, name.offset, 32)
  if (!symbol) return null
  const uri = readBorshString(buf, symbol.offset, 300)
  if (!uri) return null
  if (!name.value && !symbol.value) return null
  return { name: name.value, symbol: symbol.value, uri: uri.value }
}

export function metadataPda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), asPubkey(METAPLEX_METADATA_PROGRAM_ID).toBuffer(), asPubkey(mint).toBuffer()],
    asPubkey(METAPLEX_METADATA_PROGRAM_ID),
  )
  return pda.toBase58()
}
