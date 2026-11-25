import { parseDay, parseClosedInterval, containsDay, intervalRelation, intersectionRange } from './dates.js'
import { buildPermissionIndex, isCheckUsable } from './permissions.js'

const EXIT_TYPES = new Set(['合同结束', '主动离岗'])
const POSITIVE_ON_POST_TYPES = new Set(['在岗'])
const BOUNDED_ON_POST_TYPES = new Set(['已在岗'])

export function calendarPolicy(data, overrides = {}) {
  const limit = data.limits?.[0] ?? {}
  const reviewDay = overrides.reviewDay ?? parseDay(limit.review_day, 'review_day') ?? 25
  const horizon = overrides.horizon ?? parseDay(limit.horizon, 'horizon') ?? 21
  const slots = new Map()
  for (const row of data.limits ?? []) {
    slots.set(row.slot, {
      slot: row.slot,
      capacity: parseDay(row.capacity, 'capacity') ?? 0,
      reviewDay: parseDay(row.review_day, 'review_day') ?? reviewDay,
      horizon: parseDay(row.horizon, 'horizon') ?? horizon,
    })
  }
  return { reviewDay, horizon, slots, ...overrides }
}

export function actualReportRange(worker, checks) {
  const baseline = parseDay(worker.first_report, 'first_report')
  const receipts = checks
    .filter(c => c.subject === worker.id && c.type === '核实报到')
    .map(c => parseClosedInterval(c))
    .filter(Boolean)

  if (!receipts.length) {
    return { from: baseline, to: baseline, baseline, corrected: false, conflict: false, receipts: [] }
  }

  const overlap = intersectionRange(receipts)
  if (overlap) {
    return { ...overlap, baseline, corrected: true, conflict: false, receipts }
  }
  return {
    from: Math.min(...receipts.map(r => r.from)),
    to: Math.max(...receipts.map(r => r.to)),
    baseline,
    corrected: true,
    conflict: true,
    receipts,
  }
}

function relationToDue(interval, due) {
  return intervalRelation(interval, { from: due.from, to: due.to })
}

function makeSpell(worker, workerChecks, report) {
  const transfers = workerChecks.filter(c => c.type === '连续换岗')
  const unknownTransfers = workerChecks.filter(c => c.type === '换岗未知')
  const employers = [worker.firm]
  for (const t of transfers) if (t.reference && !employers.includes(t.reference)) employers.push(t.reference)

  const positiveIntervals = workerChecks
    .filter(c => POSITIVE_ON_POST_TYPES.has(c.type) || BOUNDED_ON_POST_TYPES.has(c.type) || c.type === '连续换岗')
    .map(c => parseClosedInterval(c))
    .filter(Boolean)
  const verifiedThrough = positiveIntervals.length ? Math.max(...positiveIntervals.map(i => i.to)) : report.to

  let continuity = 'unverified'
  if (transfers.some(c => /连续/.test(c.type))) continuity = 'continuous_transfer_verified'
  if (unknownTransfers.length) continuity = continuity === 'continuous_transfer_verified'
    ? 'continuous_then_unknown'
    : 'transfer_unknown'

  return {
    spellId: `spell:${worker.id}:1`,
    worker: worker.id,
    startDay: report.baseline,
    startRange: [report.from, report.to],
    sameSpellAcrossTransfer: transfers.length > 0 && unknownTransfers.length === 0,
    continuity,
    employers,
    verifiedThrough,
    transferChecks: transfers.map(c => c.check),
    unknownTransferChecks: unknownTransfers.map(c => c.check),
  }
}

export function assessWorker(worker, data, permissions, policy) {
  const allChecks = (data.checks ?? []).filter(c => c.subject === worker.id)
  const usableChecks = []
  const excludedEvidence = []
  for (const check of allChecks) {
    const decision = isCheckUsable(check, permissions)
    if (decision.usable) usableChecks.push(check)
    else excludedEvidence.push({
      check: check.check,
      type: check.type,
      source: check.source,
      reason: decision.reason,
      usableInNewStatistics: false,
    })
  }

  const report = actualReportRange(worker, usableChecks)
  const due = { from: report.from + policy.horizon, to: report.to + policy.horizon }
  const elapsed = {
    min: policy.reviewDay - report.to, // latest possible report => shortest elapsed
    max: policy.reviewDay - report.from,
  }

  let maturity = 'mature'
  let maturityZh = '已满观察期'
  if (policy.reviewDay < due.from) {
    maturity = 'immature'
    maturityZh = '尚未满观察期'
  } else if (policy.reviewDay < due.to) {
    maturity = 'unknown_report_interval'
    maturityZh = '报到日区间导致观察期待定'
  }

  const intervals = new Map()
  for (const c of usableChecks) intervals.set(c.check, parseClosedInterval(c))

  const exitFacts = usableChecks
    .filter(c => EXIT_TYPES.has(c.type))
    .map(c => ({ check: c.check, type: c.type, firm: c.reference, interval: intervals.get(c.check), relation: relationToDue(intervals.get(c.check), due) }))

  const certainBeforeExit = exitFacts.filter(f => f.relation === 'before')
  const horizonOverlapExit = exitFacts.filter(f => f.relation === 'overlaps')

  const onPostFacts = usableChecks
    .filter(c => POSITIVE_ON_POST_TYPES.has(c.type))
    .map(c => ({ check: c.check, type: c.type, source: c.source, interval: intervals.get(c.check) }))
  const boundedOnPostFacts = usableChecks
    .filter(c => BOUNDED_ON_POST_TYPES.has(c.type))
    .map(c => ({ check: c.check, type: c.type, source: c.source, interval: intervals.get(c.check) }))
  const lostFacts = usableChecks
    .filter(c => c.type === '失联')
    .map(c => ({ check: c.check, interval: intervals.get(c.check) }))
  const noReceiptFacts = usableChecks
    .filter(c => c.type === '无回执')
    .map(c => ({ check: c.check, interval: intervals.get(c.check) }))
  const rawNoReceiptFacts = allChecks.filter(c => c.type === '无回执').map(c => c.check)
  const unknownTransferFacts = usableChecks.filter(c => c.type === '换岗未知')

  const latestPositiveEnd = onPostFacts.length ? Math.max(...onPostFacts.map(f => f.interval?.to ?? -Infinity)) : null
  const positiveAtReview = onPostFacts.some(f => containsDay(f.interval, policy.reviewDay) || (f.interval && f.interval.to >= policy.reviewDay))
  const boundedAtReview = boundedOnPostFacts.some(f => containsDay(f.interval, policy.reviewDay))
  const latestBoundedEnd = boundedOnPostFacts.length ? Math.max(...boundedOnPostFacts.map(f => f.interval?.to ?? -Infinity)) : null

  // A later positive receipt resolves a contact interruption, but the earlier
  // gap remains visible in facts and service history.
  const activeLostFacts = lostFacts.filter(f => {
    if (latestPositiveEnd === null) return true
    return f.interval?.to > latestPositiveEnd
  })
  const hadContactGap = lostFacts.length > 0

  const spell = makeSpell(worker, usableChecks, report)

  const contractExit = exitFacts.find(f => f.type === '合同结束')
  const voluntaryExit = exitFacts.find(f => f.type === '主动离岗')

  let currentStatus = 'unverified'
  let currentStatusZh = '缺少在岗或退出凭证'
  if (positiveAtReview) {
    currentStatus = 'on_post'
    currentStatusZh = '回访截点有在岗凭证'
  } else if (contractExit) {
    currentStatus = 'contract_ended'
    currentStatusZh = '协议结束'
  } else if (voluntaryExit) {
    currentStatus = 'voluntarily_left'
    currentStatusZh = '主动离岗'
  } else if (activeLostFacts.length) {
    currentStatus = 'contact_interrupted'
    currentStatusZh = '联系中断（不等于脱岗）'
  } else if (unknownTransferFacts.length) {
    currentStatus = 'unknown_transfer'
    currentStatusZh = '换岗情况未知'
  } else if (usableChecks.some(c => c.type === '连续换岗')) {
    currentStatus = 'continuous_transfer_unverified_after'
    currentStatusZh = '连续换岗已核实，换岗后的在岗情况待回访'
  } else if (usableChecks.some(c => c.type === '核实报到')) {
    currentStatus = 'report_verified_status_unknown'
    currentStatusZh = '实际报到区间已核实，报到后在岗情况未知'
  } else if (boundedOnPostFacts.length && latestBoundedEnd !== null) {
    currentStatus = 'bounded_on_post'
    currentStatusZh = '仅知在岗日期落在可信区间内'
  } else if (noReceiptFacts.length) {
    currentStatus = 'no_receipt'
    currentStatusZh = '名册无回执（不是失联或脱岗结论）'
  }

  let horizonStatus = 'not_observable'
  let horizonStatusZh = '尚未满观察期'
  let stable = null
  let stableBasis = null

  if (certainBeforeExit.length) {
    const contract = certainBeforeExit.find(f => f.type === '合同结束')
    horizonStatus = contract ? 'exited_contract' : 'exited_voluntary'
    horizonStatusZh = contract ? '岗位期限前已协议结束' : '岗位期限前已主动离岗'
    stable = false
    stableBasis = contract ? contract.check : certainBeforeExit[0].check
  } else if (maturity === 'mature') {
    if (horizonOverlapExit.length) {
      horizonStatus = 'exit_date_overlaps_horizon'
      horizonStatusZh = '退出日期与岗位期限重叠，无法判定'
      stable = null
    } else {
      const postHorizonProof = onPostFacts.find(f => f.interval && f.interval.from >= due.to)
      const horizonCoveringProof = onPostFacts.find(f => f.interval && containsDay(f.interval, due.to))
      if (postHorizonProof || horizonCoveringProof) {
        horizonStatus = 'stable'
        horizonStatusZh = '已满期且有期满后/期满日在岗凭证'
        stable = true
        stableBasis = (postHorizonProof ?? horizonCoveringProof).check
      } else {
        horizonStatus = 'unresolved'
        horizonStatusZh = '已满观察期但留岗结论待澄清'
        stable = null
      }
    }
  }

  const withheldSourceFacts = excludedEvidence.map(e => `${e.check}:${e.type}:${e.reason}`)
  const rawCurrentStatus = rawNoReceiptFacts.length && currentStatus === 'unverified'
    ? 'no_receipt_record_withheld_from_new_statistics'
    : currentStatus
  if (currentStatus === 'unverified' && excludedEvidence.some(e => e.type === '无回执')) {
    currentStatusZh = '曾有名册无回执，但关联雇主用途已撤回；该记录不进入新统计，也不得改写成脱岗'
  }

  const batchGaps = (data.checks ?? [])
    .filter(c => c.type === '整批缺报' && c.subject === worker.firm)
    .map(c => ({ check: c.check, firm: c.subject, interval: parseClosedInterval(c) }))
  const batchGapAffected = batchGaps.length > 0

  const unresolvedNeeds = []
  if (horizonStatus === 'unresolved') {
    unresolvedNeeds.push({
      key: `horizon_status:${worker.id}`,
      kind: 'horizon_status',
      worker: worker.id,
      firms: spell.employers,
      sharedFact: `on_post_or_exit:${spell.employers[spell.employers.length - 1]}`,
      decision: `retention:${worker.id}`,
      urgency: 90,
    })
  }
  if ((maturity === 'immature' || maturity === 'unknown_report_interval') && stable !== false) {
    unresolvedNeeds.push({
      key: `pre_horizon_status:${worker.id}`,
      kind: 'pre_horizon_status',
      worker: worker.id,
      firms: spell.employers,
      sharedFact: `on_post:${spell.employers[spell.employers.length - 1]}`,
      decision: `future_retention:${worker.id}`,
      urgency: maturity === 'unknown_report_interval' ? 55 : 45,
    })
  }
  if (currentStatus === 'unknown_transfer') {
    unresolvedNeeds.push({
      key: `transfer_clarification:${worker.id}`,
      kind: 'transfer_clarification',
      worker: worker.id,
      firms: [worker.firm, ...unknownTransferFacts.map(c => c.reference).filter(Boolean)],
      sharedFact: `transfer:${worker.id}`,
      decision: `spell_continuity:${worker.id}`,
      urgency: 75,
    })
  }
  if (currentStatus === 'contact_interrupted') {
    unresolvedNeeds.push({
      key: `contact_recovery:${worker.id}`,
      kind: 'contact_recovery',
      worker: worker.id,
      firms: spell.employers,
      sharedFact: `contact:${worker.id}`,
      decision: `contact_status:${worker.id}`,
      urgency: 70,
    })
  }

  const currentEmployerCandidates = (() => {
    if (spell.sameSpellAcrossTransfer) return [spell.employers[spell.employers.length - 1]]
    if (currentStatus === 'contract_ended' || currentStatus === 'voluntarily_left') return []
    return [worker.firm]
  })()

  return {
    id: worker.id,
    worker,
    report,
    horizonDue: due,
    elapsed,
    maturity,
    maturityZh,
    stable,
    horizonStatus,
    horizonStatusZh,
    currentStatus,
    currentStatusZh,
    rawCurrentStatus,
    stableBasis,
    hadContactGap,
    activeContactInterruption: activeLostFacts.length > 0,
    noReceipt: rawNoReceiptFacts.length > 0,
    usableNoReceipt: noReceiptFacts.length > 0,
    rawNoReceiptFacts,
    batchGapAffected,
    batchGaps,
    spell,
    currentEmployerCandidates,
    facts: {
      exits: exitFacts,
      onPost: onPostFacts,
      boundedOnPost: boundedOnPostFacts,
      lost: lostFacts,
      activeLost: activeLostFacts,
      noReceipt: noReceiptFacts,
      unknownTransfers: unknownTransferFacts.map(c => c.check),
      continuousTransfers: usableChecks.filter(c => c.type === '连续换岗').map(c => c.check),
    },
    unresolvedNeeds,
    excludedEvidence,
    withheldSourceFacts,
  }
}

export function assessEmployment(data, options = {}) {
  const permissions = options.permissions ?? buildPermissionIndex(data, options.permissionOptions ?? {})
  const policy = calendarPolicy(data, options.policy ?? {})
  const byId = new Map((data.workers ?? []).map(w => [w.id, w]))
  const assessments = (data.workers ?? []).map(w => assessWorker(w, data, permissions, policy))
  const batchGaps = (data.checks ?? []).filter(c => c.type === '整批缺报')
  return {
    data,
    policy,
    permissions,
    byId,
    assessments,
    assessmentById: new Map(assessments.map(a => [a.id, a])),
    batchGaps,
  }
}
