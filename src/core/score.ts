import { RECOGNIZED_MINTS, SCORE_MODEL_SUMMARY } from './constants.js'
import { formatTokenAmount } from './format.js'
import type {
  ConcentrationReport,
  ExtensionFinding,
  HolderRow,
  SafetyScore,
  ScoreBand,
  ScoreBreakdownItem,
  TokenExtension,
} from './types.js'
import { isRecord, percentOf, sumBig } from './util.js'

export interface HolderSnapshot {
  tokenAccount: string
  owner: string | null
  amount: bigint
  excluded: boolean
  excludeReason: string | null
}

export interface RiskAssessmentInput {
  mint: string
  decimals: number
  supply: bigint
  mintAuthority: string | null
  freezeAuthority: string | null
  extensions: TokenExtension[]
  holders: HolderSnapshot[] | null
  recognized: boolean
}

export interface RiskAssessment {
  score: SafetyScore
  extensions: ExtensionFinding[]
  concentration: ConcentrationReport
}

function bandFor(score: number): { band: ScoreBand; bandLabel: string } {
  if (score >= 85) return { band: 'lower-risk', bandLabel: 'Lower structural risk' }
  if (score >= 65) return { band: 'mixed', bandLabel: 'Mixed signals' }
  if (score >= 40) return { band: 'elevated', bandLabel: 'Elevated risk' }
  return { band: 'high-risk', bandLabel: 'High risk' }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function feeBps(state: unknown): number | null {
  if (!isRecord(state)) return null
  const newer = isRecord(state.newerTransferFee) ? state.newerTransferFee : null
  const older = isRecord(state.olderTransferFee) ? state.olderTransferFee : null
  const candidates = [newer?.transferFeeBasisPoints, older?.transferFeeBasisPoints, state.transferFeeBasisPoints]
  const values = candidates.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (values.length === 0) return null
  return Math.max(...values)
}

function ext(extensions: TokenExtension[], name: string): TokenExtension | undefined {
  const needle = name.toLowerCase()
  return extensions.find((item) => item.extension.toLowerCase().replace(/[^a-z0-9]/g, '') === needle.toLowerCase())
}

function has(extensions: TokenExtension[], name: string): boolean {
  return Boolean(ext(extensions, name))
}

export function assessTokenRisk(input: RiskAssessmentInput): RiskAssessment {
  const breakdown: ScoreBreakdownItem[] = []
  const findings: ExtensionFinding[] = []
  let authority = 100
  let critical = false
  const recognized = input.recognized || input.mint in RECOGNIZED_MINTS
  const issuerPenalty = recognized ? 5 : 30
  const freezePenalty = recognized ? 5 : 25

  if (input.mintAuthority) {
    authority -= issuerPenalty
    breakdown.push({
      code: 'mint-authority',
      label: recognized ? 'Issuer mint authority' : 'Mint authority active',
      delta: -issuerPenalty,
      detail: recognized
        ? 'This recognized mint can still be minted by its issuer.'
        : 'The mint authority can create unlimited new supply.',
    })
  } else {
    breakdown.push({
      code: 'mint-authority-revoked',
      label: 'Mint authority revoked',
      delta: 0,
      detail: 'No account can mint more of this token.',
    })
  }

  if (input.freezeAuthority) {
    authority -= freezePenalty
    breakdown.push({
      code: 'freeze-authority',
      label: recognized ? 'Issuer freeze authority' : 'Freeze authority active',
      delta: -freezePenalty,
      detail: recognized
        ? 'The issuer can freeze token accounts. That is disclosed, not treated as a stealth honeypot.'
        : 'The freeze authority can freeze token accounts and stop transfers.',
    })
  }

  const permanent = ext(input.extensions, 'permanentDelegate')
  if (permanent) {
    authority -= 35
    critical = true
    const delegate = isRecord(permanent.state) && typeof permanent.state.delegate === 'string' ? permanent.state.delegate : null
    findings.push({
      name: 'PermanentDelegate',
      risk: 'danger',
      summary: delegate ? `Permanent delegate ${delegate} can transfer or burn holder tokens.` : 'A permanent delegate can transfer or burn holder tokens.',
    })
    breakdown.push({
      code: 'permanent-delegate',
      label: 'Permanent delegate',
      delta: -35,
      detail: 'A permanent delegate can move holder balances without their signature.',
    })
  }

  const hook = ext(input.extensions, 'transferHook')
  if (hook) {
    const programId = isRecord(hook.state) && typeof hook.state.programId === 'string' ? hook.state.programId : null
    const inactive = programId === '11111111111111111111111111111111'
    if (!inactive) {
      authority -= 30
      findings.push({
        name: 'TransferHook',
        risk: 'danger',
        summary: programId ? `Transfers call hook program ${programId}.` : 'Transfers call an external hook program.',
      })
      breakdown.push({
        code: 'transfer-hook',
        label: 'Transfer hook',
        delta: -30,
        detail: 'Every transfer depends on an external program that can reject sells.',
      })
    }
  }

  if (has(input.extensions, 'nonTransferable')) {
    authority -= 50
    critical = true
    findings.push({ name: 'NonTransferable', risk: 'danger', summary: 'Token accounts cannot be transferred.' })
    breakdown.push({
      code: 'non-transferable',
      label: 'Non-transferable',
      delta: -50,
      detail: 'Holders cannot send or sell this token.',
    })
  }

  const defaultState = ext(input.extensions, 'defaultAccountState')
  const defaultFrozen = isRecord(defaultState?.state)
    && ['frozen', '2'].includes(String(defaultState.state.state ?? defaultState.state.accountState ?? '').toLowerCase())
  if (defaultFrozen) {
    authority -= 30
    findings.push({ name: 'DefaultAccountState', risk: 'danger', summary: 'New token accounts start frozen.' })
    breakdown.push({
      code: 'default-frozen',
      label: 'Accounts start frozen',
      delta: -30,
      detail: 'New holders receive a frozen token account.',
    })
  }

  const fee = ext(input.extensions, 'transferFeeConfig')
  const bps = fee ? feeBps(fee.state) : null
  if (fee) {
    const penalty = bps == null ? 12 : bps > 500 ? 25 : bps > 100 ? 12 : bps > 0 ? 5 : 0
    if (bps != null && bps >= 1000) critical = true
    if (penalty > 0) authority -= penalty
    const pct = bps == null ? 'unknown' : `${(bps / 100).toFixed(2)}%`
    findings.push({
      name: 'TransferFeeConfig',
      risk: penalty >= 12 ? 'warn' : 'info',
      summary: `Transfer fee ${pct}.`,
    })
    if (penalty > 0) {
      breakdown.push({
        code: 'transfer-fee',
        label: 'Transfer fee',
        delta: -penalty,
        detail: `A ${pct} fee is taken from transfers.`,
      })
    }
  }

  const pausable = ext(input.extensions, 'pausable') ?? ext(input.extensions, 'pausableConfig')
  if (pausable) {
    const paused = isRecord(pausable.state) && pausable.state.paused === true
    const penalty = paused ? 25 : 15
    authority -= penalty
    findings.push({
      name: 'Pausable',
      risk: paused ? 'danger' : 'warn',
      summary: paused ? 'Transfers are currently paused.' : 'An authority can pause transfers.',
    })
    breakdown.push({
      code: 'pausable',
      label: paused ? 'Transfers paused' : 'Pausable',
      delta: -penalty,
      detail: paused ? 'The mint is paused.' : 'An authority can halt transfers later.',
    })
  }

  if (input.extensions.some((item) => item.extension.toLowerCase().includes('confidential'))) {
    authority -= 5
    findings.push({ name: 'ConfidentialTransfer', risk: 'info', summary: 'Confidential transfers are enabled on this mint.' })
    breakdown.push({
      code: 'confidential',
      label: 'Confidential transfers',
      delta: -5,
      detail: 'Balances may be hidden from ordinary wallets.',
    })
  }

  const infoNames = ['metadataPointer', 'tokenMetadata', 'groupPointer', 'groupMemberPointer', 'interestBearingConfig', 'scaledUiAmountConfig', 'mintCloseAuthority']
  for (const name of infoNames) {
    const found = ext(input.extensions, name)
    if (!found) continue
    findings.push({ name: found.extension, risk: 'info', summary: 'Extension is present.' })
  }

  const known = new Set(findings.map((item) => item.name.toLowerCase().replace(/[^a-z0-9]/g, '')))
  for (const item of input.extensions) {
    const key = item.extension.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (known.has(key)) continue
    if (['transferhook', 'permanentdelegate', 'nontransferable', 'defaultaccountstate', 'transferfeeconfig', 'pausable', 'pausableconfig'].includes(key)) continue
    if (item.extension.toLowerCase().includes('confidential')) continue
    findings.push({ name: item.extension, risk: 'info', summary: 'Extension is present and was not scored as a known risk.' })
  }

  if (input.freezeAuthority && hook && !findings.some((item) => item.name === 'TransferHook' && item.summary.includes('11111111111111111111111111111111'))) {
    const hookProgram = isRecord(hook.state) ? hook.state.programId : null
    if (hookProgram !== '11111111111111111111111111111111') critical = true
  }
  if (input.freezeAuthority && defaultFrozen) critical = true

  authority = clamp(authority)
  const concentration = summarizeConcentration(input.supply, input.decimals, input.holders)
  let distribution = concentration.available ? distributionScore(concentration) : null
  if (distribution != null) {
    const top1 = concentration.circulatingTop1Pct
    const top10 = concentration.circulatingTop10Pct
    if (top1 != null && top1 >= 15) {
      breakdown.push({ code: 'top1', label: 'Top holder', delta: 0, detail: `Largest non-LP holder has ${top1.toFixed(2)}% of supply.` })
    }
    if (top10 != null) {
      breakdown.push({ code: 'top10', label: 'Top 10 holders', delta: 0, detail: `Top 10 non-LP holders have ${top10.toFixed(2)}% of supply.` })
    }
  }

  let composite = distribution == null ? authority : Math.round((authority + distribution) / 2)
  let protectedFloor = false
  if (critical) composite = Math.min(composite, 45)
  if (recognized && authority >= 80 && !critical) {
    if (composite < 88) protectedFloor = true
    composite = Math.max(composite, 88)
  }
  composite = clamp(composite)
  const { band, bandLabel } = bandFor(composite)

  const badges = scoreBadges({
    recognized,
    mintAuthority: input.mintAuthority,
    freezeAuthority: input.freezeAuthority,
    critical,
    band,
    concentration,
  })

  return {
    extensions: findings,
    concentration,
    score: {
      composite,
      authority,
      distribution,
      band,
      bandLabel,
      criticalCap: critical,
      protectedFloor,
      breakdown,
      badges,
      summary: SCORE_MODEL_SUMMARY,
    },
  }
}

function distributionScore(report: ConcentrationReport): number {
  let score = 100
  const top1 = report.circulatingTop1Pct ?? 0
  const top5 = report.circulatingTop5Pct ?? 0
  const top10 = report.circulatingTop10Pct ?? 0
  if (top1 >= 15) score -= 10
  if (top1 >= 30) score -= 15
  if (top1 >= 50) score -= 25
  if (top5 >= 70) score -= 10
  if (top10 >= 60) score -= 10
  if (top10 >= 80) score -= 15
  return clamp(score)
}

export function summarizeConcentration(
  supply: bigint,
  decimals: number,
  holders: HolderSnapshot[] | null,
): ConcentrationReport {
  if (holders == null) {
    return {
      available: false,
      sampleSize: 0,
      excludedCount: 0,
      lpSharePct: null,
      circulatingTop1Pct: null,
      circulatingTop5Pct: null,
      circulatingTop10Pct: null,
      rawTop1Pct: null,
      rawTop10Pct: null,
      note: 'Holder accounts were not available from this RPC. The score uses authorities and extensions only.',
      holders: [],
    }
  }

  const sorted = [...holders].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
  const excluded = sorted.filter((holder) => holder.excluded)
  const circulating = sorted.filter((holder) => !holder.excluded)
  const excludedSupply = sumBig(excluded.map((holder) => holder.amount))
  const top = (list: HolderSnapshot[], count: number) => sumBig(list.slice(0, count).map((holder) => holder.amount))
  const rows: HolderRow[] = sorted.slice(0, 20).map((holder, index) => ({
    rank: index + 1,
    tokenAccount: holder.tokenAccount,
    owner: holder.owner,
    amount: holder.amount.toString(),
    amountUi: formatTokenAmount(holder.amount, decimals),
    supplyPct: percentOf(holder.amount, supply),
    excluded: holder.excluded,
    excludeReason: holder.excludeReason,
  }))

  const circulatingSupply = supply > excludedSupply ? supply - excludedSupply : 0n
  return {
    available: true,
    sampleSize: circulating.length,
    excludedCount: excluded.length,
    lpSharePct: percentOf(excludedSupply, supply),
    circulatingTop1Pct: percentOf(top(circulating, 1), supply),
    circulatingTop5Pct: percentOf(top(circulating, 5), supply),
    circulatingTop10Pct: percentOf(top(circulating, 10), supply),
    rawTop1Pct: percentOf(top(sorted, 1), supply),
    rawTop10Pct: percentOf(top(sorted, 10), supply),
    note: circulatingSupply === 0n
      ? 'Every large account in the RPC sample was classified as an LP, curve, or burn address.'
      : 'Top-holder percentages use total supply as the denominator and omit burn addresses plus accounts owned by known LP or launchpad programs. The sample is the top 20 token accounts returned by RPC.',
    holders: rows,
  }
}

function scoreBadges(input: {
  recognized: boolean
  mintAuthority: string | null
  freezeAuthority: string | null
  critical: boolean
  band: ScoreBand
  concentration: ConcentrationReport
}): SafetyScore['badges'] {
  const badges: SafetyScore['badges'] = []
  if (input.recognized) badges.push({ tone: 'info', label: 'Recognized mint' })
  if (!input.mintAuthority && !input.freezeAuthority) badges.push({ tone: 'good', label: 'Authorities revoked' })
  if (input.mintAuthority && !input.recognized) badges.push({ tone: 'bad', label: 'Mint authority active' })
  if (input.freezeAuthority && !input.recognized) badges.push({ tone: 'bad', label: 'Freeze authority active' })
  if (input.critical) badges.push({ tone: 'bad', label: 'Critical extension' })
  const top1 = input.concentration.circulatingTop1Pct
  if (top1 != null && top1 >= 30) badges.push({ tone: 'warn', label: 'Concentrated supply' })
  if (input.band === 'lower-risk' && !input.critical) badges.push({ tone: 'good', label: 'Lower structural risk' })
  if (input.band === 'high-risk') badges.push({ tone: 'bad', label: 'High risk' })
  return badges
}
