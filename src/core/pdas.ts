import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from './constants.js'
import { asPubkey } from './util.js'

export interface CreatorFeeAddresses {
  pumpCreatorVault: string
  pumpSwapCreatorAuthority: string
  pumpSwapWsolAta: string
}

export function deriveCreatorFeeAccounts(wallet: string): CreatorFeeAddresses {
  const owner = asPubkey(wallet)
  const [pumpCreatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), owner.toBuffer()],
    asPubkey(PUMP_PROGRAM_ID),
  )
  const [pumpSwapCreatorAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), owner.toBuffer()],
    asPubkey(PUMP_SWAP_PROGRAM_ID),
  )
  const pumpSwapWsolAta = getAssociatedTokenAddressSync(
    asPubkey(WSOL_MINT),
    pumpSwapCreatorAuthority,
    true,
    asPubkey(TOKEN_PROGRAM_ID),
  )
  return {
    pumpCreatorVault: pumpCreatorVault.toBase58(),
    pumpSwapCreatorAuthority: pumpSwapCreatorAuthority.toBase58(),
    pumpSwapWsolAta: pumpSwapWsolAta.toBase58(),
  }
}
