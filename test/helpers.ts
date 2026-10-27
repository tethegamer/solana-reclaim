import { Keypair, PublicKey } from '@solana/web3.js'

export function keyed(byte: number): PublicKey {
  return Keypair.fromSeed(Buffer.alloc(32, byte)).publicKey
}

export function address(byte: number): string {
  return keyed(byte).toBase58()
}
