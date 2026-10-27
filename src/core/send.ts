import { PACKET_DATA_SIZE } from './constants.js'
import { ReclaimError } from './errors.js'
import { rpcRunner } from './rpc.js'
import { Transaction, VersionedTransaction, type Connection } from '@solana/web3.js'

export async function sendSignedTransaction(
  base64: string,
  options: { connection?: Connection; rpcUrl?: string } = {},
): Promise<{ signature: string; explorer: string }> {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length < 64 || raw.length > PACKET_DATA_SIZE) {
    throw new ReclaimError('INVALID_TRANSACTION', 'Transaction must be a signed Solana packet of at most 1232 bytes')
  }
  if (!hasSignature(raw)) {
    throw new ReclaimError('INVALID_TRANSACTION', 'Transaction has no signature')
  }
  const rpc = rpcRunner(options)
  const signature = await rpc.run(
    (connection) => connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }),
    'sendRawTransaction',
  )
  return { signature, explorer: `https://solscan.io/tx/${signature}` }
}

function hasSignature(raw: Buffer): boolean {
  try {
    const versioned = VersionedTransaction.deserialize(raw)
    return versioned.signatures.some((signature) => signature.some((byte) => byte !== 0))
  } catch {
    try {
      const tx = Transaction.from(raw)
      return tx.signatures.some((entry) => entry.signature != null && entry.signature.some((byte) => byte !== 0))
    } catch {
      throw new ReclaimError('INVALID_TRANSACTION', 'Could not decode a Solana transaction')
    }
  }
}
