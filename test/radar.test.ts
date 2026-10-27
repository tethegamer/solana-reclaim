import { describe, expect, it } from 'vitest'
import { USDC_MINT } from '../src/core/constants.js'
import { holderExclusion } from '../src/core/holders.js'
import { assessTokenRisk } from '../src/core/score.js'
import type { TokenExtension } from '../src/core/types.js'
import { address } from './helpers.js'

function holders(amounts: bigint[], excluded = false) {
  return amounts.map((amount, index) => ({
    tokenAccount: address(30 + index),
    owner: address(60 + index),
    amount,
    excluded,
    excludeReason: excluded ? 'Owned by an LP or launchpad program' : null,
  }))
}

describe('assessTokenRisk', () => {
  it('scores a revoked mint with dispersed holders as lower risk', () => {
    const supply = 1_000_000n
    const report = assessTokenRisk({
      mint: address(3),
      decimals: 6,
      supply,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [],
      holders: holders([50_000n, 40_000n, 30_000n, 20_000n]),
      recognized: false,
    })
    expect(report.score.authority).toBe(100)
    expect(report.score.composite).toBeGreaterThanOrEqual(85)
    expect(report.score.band).toBe('lower-risk')
    expect(report.concentration.circulatingTop1Pct).toBe(5)
  })

  it('penalizes mint and freeze authority on an unknown mint', () => {
    const report = assessTokenRisk({
      mint: address(3),
      decimals: 6,
      supply: 100n,
      mintAuthority: address(4),
      freezeAuthority: address(5),
      extensions: [],
      holders: [],
      recognized: false,
    })
    expect(report.score.authority).toBe(45)
    expect(report.score.badges.some((badge) => badge.label === 'Mint authority active')).toBe(true)
    expect(report.score.badges.some((badge) => badge.label === 'Freeze authority active')).toBe(true)
  })

  it('caps the score when a permanent delegate or non-transferable extension is present', () => {
    const extensions: TokenExtension[] = [{ extension: 'permanentDelegate', state: { delegate: address(9) } }]
    const permanent = assessTokenRisk({
      mint: address(3),
      decimals: 6,
      supply: 100n,
      mintAuthority: null,
      freezeAuthority: null,
      extensions,
      holders: null,
      recognized: false,
    })
    expect(permanent.score.criticalCap).toBe(true)
    expect(permanent.score.composite).toBeLessThanOrEqual(45)
    expect(permanent.extensions.some((item) => item.name === 'PermanentDelegate' && item.risk === 'danger')).toBe(true)

    const soulbound = assessTokenRisk({
      mint: address(3),
      decimals: 0,
      supply: 100n,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [{ extension: 'nonTransferable' }],
      holders: holders([10n]),
      recognized: false,
    })
    expect(soulbound.score.composite).toBeLessThanOrEqual(45)
    expect(soulbound.score.authority).toBe(50)
  })

  it('scores a high transfer fee and a transfer hook', () => {
    const report = assessTokenRisk({
      mint: address(3),
      decimals: 6,
      supply: 1_000n,
      mintAuthority: null,
      freezeAuthority: address(5),
      extensions: [
        { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 1_000 } } },
        { extension: 'transferHook', state: { programId: address(8) } },
      ],
      holders: [],
      recognized: false,
    })
    expect(report.score.criticalCap).toBe(true)
    expect(report.score.composite).toBeLessThanOrEqual(45)
    expect(report.extensions.map((item) => item.name)).toEqual(expect.arrayContaining(['TransferFeeConfig', 'TransferHook']))
  })

  it('drops the distribution score when supply is concentrated outside LP vaults', () => {
    const supply = 1_000n
    const report = assessTokenRisk({
      mint: address(3),
      decimals: 6,
      supply,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [],
      holders: [
        ...holders([800n]),
        { tokenAccount: address(90), owner: address(91), amount: 150n, excluded: true, excludeReason: 'Known LP vault authority' },
      ],
      recognized: false,
    })
    expect(report.concentration.lpSharePct).toBe(15)
    expect(report.concentration.circulatingTop1Pct).toBe(80)
    expect(report.score.distribution).toBeLessThan(50)
    expect(report.score.badges.some((badge) => badge.label === 'Concentrated supply')).toBe(true)
  })

  it('floors recognized issuer mints when the only flags are issuer authorities', () => {
    const report = assessTokenRisk({
      mint: USDC_MINT,
      decimals: 6,
      supply: 1_000n,
      mintAuthority: address(4),
      freezeAuthority: address(5),
      extensions: [],
      holders: holders([900n]),
      recognized: true,
    })
    expect(report.score.authority).toBeGreaterThanOrEqual(80)
    expect(report.score.protectedFloor).toBe(true)
    expect(report.score.composite).toBe(88)
    expect(report.score.badges.some((badge) => badge.label === 'Recognized mint')).toBe(true)
    expect(report.concentration.circulatingTop1Pct).toBe(90)
  })
})

describe('holderExclusion', () => {
  it('excludes burn addresses, Raydium vaults, and AMM-owned accounts', () => {
    expect(holderExclusion({
      owner: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
      ownerProgram: null,
    }).excluded).toBe(true)
    expect(holderExclusion({
      owner: address(3),
      ownerProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    }).reason).toMatch(/launchpad/i)
    expect(holderExclusion({ owner: address(3), ownerProgram: address(4), ownerExecutable: true }).excluded).toBe(true)
    expect(holderExclusion({ owner: address(3), ownerProgram: address(4) }).excluded).toBe(false)
  })
})
