import { BURN_OWNER_IDS, VAULT_OWNER_IDS, VAULT_PROGRAM_IDS } from './constants.js'

export function holderExclusion(input: {
  owner: string | null
  ownerProgram: string | null
  ownerExecutable?: boolean
}): { excluded: boolean; reason: string | null } {
  if (input.owner && BURN_OWNER_IDS.has(input.owner)) {
    return { excluded: true, reason: 'Burn address' }
  }
  if (input.owner && VAULT_OWNER_IDS.has(input.owner)) {
    return { excluded: true, reason: 'Known LP vault authority' }
  }
  if (input.ownerExecutable) {
    return { excluded: true, reason: 'Executable program' }
  }
  if (input.ownerProgram && VAULT_PROGRAM_IDS.has(input.ownerProgram)) {
    return { excluded: true, reason: 'Owned by an LP or launchpad program' }
  }
  return { excluded: false, reason: null }
}
