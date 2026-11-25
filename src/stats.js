import { intersectionRange } from './dates.js'
import { effectiveContact, employerGrant } from './permissions.js'

function pct(n, d) {
  return d === 0 ? null : Number((n / d).toFixed(4))
}

function groupWorkers(assessments, key) {
  const map = new Map()
  for (const a of assessments) {
    const value = key === 'source' ? a.worker.source : key === 'channel' ? a.worker.channel : `${a.worker.source} / ${a.worker.channel}`
    if (!map.has(value)) map.set(value, [])
    map.get(value).push(a)
  }
  return map
}

function observationSummary(rows) {
  const reports = rows.map(a => a.report)
  const dues = rows.map(a => a.horizonDue)
  const ranges = rows.map(a => ({ from: a.report.from, to: a.horizonDue.to }))
  const matureRanges = rows.filter(a => a.maturity === 'mature').map(a => ({ from: a.report.from, to: a.horizonDue.to }))
  return {
    reportMin: Math.min(...reports.map(r => r.from)),
    reportMax: Math.max(...reports.map(r => r.to)),
    horizonDueMin: Math.min(...dues.map(d => d.from)),
    horizonDueMax: Math.max(...dues.map(d => d.to)),
    commonWindow: intersectionRange(ranges),
    matureCommonWindow: intersectionRange(matureRanges),
  }
}

function coverageSummary(rows, analysis) {
  const data = analysis.data
  const permissions = analysis.permissions
  let personalFollowup = 0
  let phoneRegistered = 0
  let employerConsent = 0
  let activeEmployerGrant = 0
  let callableSomeSlot = 0
  let refusedOrMissingWindow = 0

  for (const a of rows) {
    const w = a.worker
    const personal = (data.checks ?? []).some(c =>
      c.subject === w.id && (c.source === '个人' || c.source === '补回'))
    if (personal) personalFollowup += 1

    const contact = effectiveContact(w, permissions)
    if (contact.phoneAllowed && contact.slots.length) phoneRegistered += 1
    if (contact.employerAllowed) employerConsent += 1
    const grant = employerGrant(w.id, w.firm, permissions)
    if (grant.allowed) activeEmployerGrant += 1
    if (contact.methods.length && contact.slots.length) callableSomeSlot += 1
    if (contact.refused || !contact.slots.length) refusedOrMissingWindow += 1
  }

  const mature = rows.filter(a => a.maturity === 'mature')
  const followedMature = mature.filter(a => (data.checks ?? []).some(c =>
    c.subject === a.id && (c.source === '个人' || c.source === '补回')))
  return {
    personalFollowup,
    personalFollowupRate: pct(personalFollowup, rows.length),
    phoneRegistered,
    employerConsent,
    activeEmployerGrant,
    callableSomeSlot,
    refusedOrMissingWindow,
    maturePersonalFollowup: followedMature.length,
  }
}

export function summarizeGroup(groupName, rows, analysis, options = {}) {
  const mature = rows.filter(a => a.maturity === 'mature')
  const immature = rows.filter(a => a.maturity === 'immature')
  const maturityUnknown = rows.filter(a => a.maturity === 'unknown_report_interval')
  const stable = mature.filter(a => a.horizonStatus === 'stable')
  const exitedContract = mature.filter(a => a.horizonStatus === 'exited_contract')
  const exitedVoluntary = mature.filter(a => a.horizonStatus === 'exited_voluntary')
  const exited = [...exitedContract, ...exitedVoluntary]
  const unresolved = mature.filter(a => a.horizonStatus === 'unresolved' || a.horizonStatus === 'exit_date_overlaps_horizon')
  const batchAffected = rows.filter(a => a.batchGapAffected)
  const batchMaterial = rows.filter(a => a.batchGapAffected && (a.horizonStatus === 'unresolved' || a.horizonStatus === 'exit_date_overlaps_horizon' || a.currentStatus === 'no_receipt'))

  const lower = stable.length
  const upper = stable.length + unresolved.length
  const knownExitedAll = rows.filter(a => a.stable === false)
  const immatureButExited = knownExitedAll.filter(a => a.maturity !== 'mature')
  const coverage = coverageSummary(rows, analysis)
  const followedMatureIds = new Set(mature
    .filter(a => analysis.data.checks.some(c => c.subject === a.id && (c.source === '个人' || c.source === '补回')))
    .map(a => a.id))
  const followedStable = stable.filter(a => followedMatureIds.has(a.id)).length
  const followedExited = exited.filter(a => followedMatureIds.has(a.id)).length
  const followedUnresolved = followedMatureIds.size - followedStable - followedExited

  const minMature = options.minMature ?? 1
  const conditions = [
    { code: 'group_values_registered', met: rows.every(a => a.worker.source !== '?' && a.worker.channel !== '?'), detailZh: '来源地与输送方式均已登记' },
    { code: 'mature_observations_present', met: mature.length > 0, detailZh: `已满观察期 ${mature.length} 人` },
    { code: 'minimum_mature_cell', met: mature.length >= minMature, required: minMature, actual: mature.length, detailZh: `可做点估计的最低满期样本数为 ${minMature}` },
    { code: 'contact_windows_registered', met: coverage.refusedOrMissingWindow === 0, actualMissing: coverage.refusedOrMissingWindow, detailZh: '拒接或缺少可拨打星期的对象不能视为脱岗' },
    { code: 'personal_followup_coverage', met: coverage.personalFollowup === rows.length, covered: coverage.personalFollowup, total: rows.length, detailZh: '个人回访覆盖情况；未覆盖只限制可支持范围' },
    { code: 'employer_scopes_registered', met: coverage.employerConsent === coverage.activeEmployerGrant, employerConsent: coverage.employerConsent, activeGrant: coverage.activeEmployerGrant, detailZh: '雇主方式同意与有效授权范围需同时具备' },
    { code: 'batch_gaps_disclosed', met: true, affected: batchAffected.length, materialUnresolved: batchMaterial.length, detailZh: '同雇主整批漏报已单独显示，不按漏接电话处理' },
  ]

  return {
    group: groupName,
    total: rows.length,
    maturity: {
      mature: mature.length,
      immature: immature.length,
      unknownReportInterval: maturityUnknown.length,
    },
    horizonOutcomes: {
      stable: stable.length,
      exitedContract: exitedContract.length,
      exitedVoluntary: exitedVoluntary.length,
      exitedTotal: exited.length,
      exitedKnownAll: knownExitedAll.length,
      immatureButExited: immatureButExited.length,
      unresolved: unresolved.length,
    },
    allCohortSupportable: {
      denominator: rows.length,
      confirmedStable: stable.length,
      knownExited: knownExitedAll.length,
      lowerRate: pct(stable.length, rows.length),
      upperRate: pct(rows.length - knownExitedAll.length, rows.length),
      noteZh: '全队列最宽范围：已知退出计为下限外，其余未满期/未澄清对象均保留为可能稳定，不能按未接电话记退出。',
    },
    retentionAmongMature: {
      denominator: mature.length,
      confirmedLower: lower,
      supportableUpper: upper,
      lowerRate: pct(lower, mature.length),
      upperRate: pct(upper, mature.length),
      pointRateIfAllResolvedStable: null,
    },
    directlyFollowedMature: {
      denominator: followedMatureIds.size,
      stable: followedStable,
      exited: followedExited,
      unresolved: followedUnresolved,
      lowerRate: pct(followedStable, followedMatureIds.size),
      upperRate: pct(followedStable + followedUnresolved, followedMatureIds.size),
      warningZh: '完整回访个案可能存在选择偏差，不能替代全组区间',
    },
    currentStatusCounts: {
      onPost: rows.filter(a => a.currentStatus === 'on_post').length,
      boundedOnPost: rows.filter(a => a.currentStatus === 'bounded_on_post').length,
      contractEnded: rows.filter(a => a.currentStatus === 'contract_ended').length,
      voluntarilyLeft: rows.filter(a => a.currentStatus === 'voluntarily_left').length,
      contactInterrupted: rows.filter(a => a.currentStatus === 'contact_interrupted').length,
      noReceipt: rows.filter(a => a.currentStatus === 'no_receipt').length,
      unknownTransfer: rows.filter(a => a.currentStatus === 'unknown_transfer').length,
      continuousTransferUnverifiedAfter: rows.filter(a => a.currentStatus === 'continuous_transfer_unverified_after').length,
      reportVerifiedStatusUnknown: rows.filter(a => a.currentStatus === 'report_verified_status_unknown').length,
      unverified: rows.filter(a => a.currentStatus === 'unverified').length,
    },
    batchMissing: {
      affected: batchAffected.length,
      materialUnresolved: batchMaterial.length,
    },
    coverage,
    observation: observationSummary(rows),
    conditions,
  }
}

function comparison(dimension, tables, analysis, options = {}) {
  const groups = tables.map(t => t.group)
  const windows = tables.map(t => t.observation.matureCommonWindow).filter(Boolean)
  const overlap = intersectionRange(windows)
  const maxCoverageGap = options.maxCoverageGap ?? 1
  const coverageRates = tables.map(t => t.coverage.personalFollowupRate ?? 0)
  const coverageGap = coverageRates.length ? Math.max(...coverageRates) - Math.min(...coverageRates) : 0
  const allCommonPolicy = new Set(tables.map(() => analysis.policy.reviewDay)).size === 1
  const conditions = [
    { code: 'same_review_day_and_horizon', met: allCommonPolicy, reviewDay: analysis.policy.reviewDay, horizon: analysis.policy.horizon },
    { code: 'mature_in_every_group', met: tables.every(t => t.maturity.mature > 0), matureCounts: tables.map(t => t.maturity.mature) },
    { code: 'mature_windows_overlap', met: !!overlap, overlap },
    { code: 'no_group_has_registration_gap', met: tables.every(t => t.conditions.find(c => c.code === 'contact_windows_registered')?.met) },
    { code: 'followup_coverage_measured', met: tables.every(t => t.coverage.personalFollowupRate !== null), rates: coverageRates },
    { code: 'followup_coverage_gap_within_policy', met: coverageGap <= maxCoverageGap, gap: Number(coverageGap.toFixed(4)), maxAllowedGap: maxCoverageGap, detailZh: '阈值由评估政策指定；未满足时只能并列覆盖区间，不能把覆盖差异解释为留岗差异' },
    { code: 'withdrawn_uses_excluded', met: true, excludedEvidence: analysis.assessments.reduce((n, a) => n + a.excludedEvidence.length, 0) },
  ]
  const canPointCompare = conditions.every(c => c.met) && tables.every(t => t.conditions.find(x => x.code === 'minimum_mature_cell')?.met)
  return {
    dimension,
    groups,
    overlap,
    canPointCompare,
    resultType: canPointCompare ? 'point_or_interval' : 'bounds_and_registration_warnings_only',
    conditions,
    messageZh: canPointCompare
      ? '登记、观察期和覆盖条件满足，可同时看点估计与区间。'
      : '登记或观察条件未完全满足；只能并列可支持区间并说明未满足条件，不能作简单排名。',
  }
}

export function buildStatistics(analysis, options = {}) {
  const dimensions = options.dimensions ?? ['source', 'channel', 'source_channel']
  const tables = {}
  const comparisons = []

  for (const dimension of dimensions) {
    const key = dimension === 'source_channel' ? 'source_channel' : dimension
    const grouped = groupWorkers(analysis.assessments, key)
    const rows = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh'))
      .map(([name, list]) => summarizeGroup(name, list, analysis, options))
    tables[dimension] = rows
    if (dimension === 'source' || dimension === 'channel') {
      comparisons.push(comparison(dimension, rows, analysis, options))
    }
  }

  return {
    generatedFor: '仅含来源地、输送方式等合成分组；不含个人编号',
    policy: analysis.policy,
    tables,
    comparisons,
  }
}
