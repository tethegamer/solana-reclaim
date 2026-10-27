/** Mainnet rent constants: 3,480 lamports per byte-year, 2-year exemption, 128-byte overhead. */
export const LAMPORTS_PER_BYTE_YEAR = 3_480
export const EXEMPTION_YEARS = 2
export const ACCOUNT_STORAGE_OVERHEAD = 128
export const TOKEN_ACCOUNT_SIZE = 165

export function rentExemptLamports(dataLength: number): number {
  if (!Number.isInteger(dataLength) || dataLength < 0) {
    throw new Error('dataLength must be a non-negative integer')
  }
  return (dataLength + ACCOUNT_STORAGE_OVERHEAD) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_YEARS
}

export const STANDARD_TOKEN_RENT_LAMPORTS = rentExemptLamports(TOKEN_ACCOUNT_SIZE)
export const ZERO_DATA_RENT_LAMPORTS = rentExemptLamports(0)

export function claimableAfterRent(lamports: number, dataLength: number): number {
  return Math.max(0, lamports - rentExemptLamports(dataLength))
}
