import { intervalsOverlap } from './dates.js'

export const DEFAULT_CASE_POLICY = {
  // Township thresholds are intentionally not invented here. A deployment may
  // pass confirmed rules such as:
  // townships: { 乡甲: { lostContactDays: 7 }, 乡乙: { lostContactRegistrations: 2 } }
  townships: {},
  defaultLostContactDays: null,
  defaultLostContactRegistrations: null,
}

function ruleForTownship(township, policy = {}) {
  const merged = { ...DEFAULT_CASE_POLICY, ...policy }
  const local = merged.townships?.[township] ?? {}
  return {
    lostContactDays: local.lostContactDays ?? merged.defaultLostContactDays ?? null,
    lostContactRegistrations: local.lostContactRegistrations ?? merged.defaultLostContactRegistrations ?? null,
    match: local.match ?? merged.defaultMatch ?? 'any',
  }
}

function lostContactEvaluation(assessment, rule) {
  const registrations = assessment.facts.lost
  const positive = assessment.facts.onPost.map(f => f.interval).filter(Boolean)
  let longestUnresolvedDays = 0
  let historicalLongestDays = 0

  for (const lost of registrations) {
    if (!lost.interval) continue
    historicalLongestDays = Math.max(historicalLongestDays, lost.interval.to - lost.interval.from + 1)
    let effectiveTo = lost.interval.to
    for (const p of positive) {
      if (intervalsOverlap(lost.interval, p)) {
        // Positive proof beginning inside the gap truncates the unverified gap.
        effectiveTo = Math.min(effectiveTo, p.from - 1)
      }
    }
    if (effectiveTo >= lost.interval.from) {
      longestUnresolvedDays = Math.max(longestUnresolvedDays, effectiveTo - lost.interval.from + 1)
    }
  }

  const registrationCount = registrations.length
  const daysMet = rule.lostContactDays !== null && longestUnresolvedDays >= rule.lostContactDays
  const registrationsMet = rule.lostContactRegistrations !== null && registrationCount >= rule.lostContactRegistrations
  const configured = rule.lostContactDays !== null || rule.lostContactRegistrations !== null
  const met = configured && (rule.match === 'all' ? daysMet && registrationsMet : daysMet || registrationsMet)
  return {
    configured,
    match: rule.match ?? 'any',
    registrationCount,
    historicalLongestDays,
    longestUnresolvedDays,
    requiredDays: rule.lostContactDays,
    requiredRegistrations: rule.lostContactRegistrations,
    met: configured && (daysMet || registrationsMet),
    currentlyResolved: registrations.length > 0 && longestUnresolvedDays === 0,
    evidence: registrations.map(f => f.check),
  }
}

export function evaluateCases(analysis, options = {}) {
  const casePolicy = options.casePolicy ?? {}
  const existing = analysis.data.followup_cases ?? []
  const existingByWorker = new Map()
  for (const c of existing) {
    if (!existingByWorker.has(c.worker)) existingByWorker.set(c.worker, [])
    existingByWorker.get(c.worker).push(c)
  }

  const preservedCases = existing.map(c => {
    const a = analysis.assessmentById.get(c.worker)
    const township = a?.worker.source
    const rule = ruleForTownship(township, casePolicy)
    const lost = a ? lostContactEvaluation(a, rule) : null
    const contractMet = !!a?.facts.exits.some(f => f.type === '合同结束')
    return {
      ...c,
      ownerPreserved: true,
      originalResponsiblePointContinues: true,
      township,
      publicRule: c.rule,
      verifiableFacts: c.rule === '合同结束'
        ? a?.facts.exits.filter(f => f.type === '合同结束').map(f => f.check) ?? []
        : c.rule === '持续失联'
          ? lost?.evidence ?? []
          : [],
      ruleCheck: c.rule === '合同结束'
        ? { met: contractMet, basis: 'contract_end_record' }
        : c.rule === '持续失联'
          ? lost
          : { met: false, basis: 'not_county_automatic_trigger', noteZh: '连续转岗等已受理个案继续原责任点工作，但不新增县级帮扶触发' },
    }
  })

  const proposals = []
  const assistanceUnits = []

  for (const a of analysis.assessments) {
    const rule = ruleForTownship(a.worker.source, casePolicy)
    const contractFacts = a.facts.exits.filter(f => f.type === '合同结束').map(f => f.check)
    const lost = lostContactEvaluation(a, rule)
    const triggers = []
    if (contractFacts.length) {
      triggers.push({ rule: '合同结束', met: true, evidence: contractFacts })
    }
    if (lost.configured && lost.met) {
      triggers.push({ rule: '持续失联', met: true, evidence: lost.evidence, detail: lost })
    }
    if (!triggers.length) continue

    const prior = existingByWorker.get(a.id) ?? []
    const countyCase = prior.find(c => c.rule === '合同结束' || c.rule === '持续失联') ?? prior[0]
    const unit = {
      worker: a.id,
      owner: countyCase?.owner ?? a.worker.source,
      existingCase: countyCase?.case ?? null,
      stage: countyCase?.stage ?? '拟新增',
      triggers,
      // Multiple checks/sources for the same transferred worker create one unit.
      sourceCount: new Set(triggers.flatMap(t => t.evidence)).size,
      assistanceCount: 1,
      duplicateSourcesCollapsed: true,
    }
    assistanceUnits.push(unit)

    if (!countyCase) {
      proposals.push({
        proposedCase: `AUTO-${a.id}`,
        worker: a.id,
        owner: a.worker.source,
        rule: triggers[0].rule,
        allTriggerRules: triggers.map(t => t.rule),
        evidence: [...new Set(triggers.flatMap(t => t.evidence))],
        stage: '待受理',
        reasonZh: '仅依据公开规则和可核实记录生成；覆盖不足本身不触发帮扶标签',
      })
    }
  }

  return {
    preservedCases,
    proposals,
    assistanceUnits,
    publicPolicyZh: '县级帮扶仅因可核实的合同结束，或达到务工对象所属乡确认阈值的持续失联登记而生效。',
  }
}

export function buildServicePriorities(analysis, caseEvaluation) {
  const priorities = []
  const caseByWorker = new Map()
  for (const c of caseEvaluation.preservedCases) {
    if (!caseByWorker.has(c.worker)) caseByWorker.set(c.worker, c)
  }

  for (const a of analysis.assessments) {
    const existingCase = caseByWorker.get(a.id)
    const unit = caseEvaluation.assistanceUnits.find(u => u.worker === a.id)
    let weight = 0
    const reasons = []

    if (existingCase && !['已结案', '已结束'].includes(existingCase.stage)) {
      weight += 100
      reasons.push('已有受理个案，原责任点继续')
    }
    if (unit) {
      weight += 80
      reasons.push('帮扶规则已由可核实事实触发')
    }
    if (a.horizonStatus === 'unresolved') {
      weight += 50
      reasons.push('结论可被近期核验改变')
    }
    if (a.currentStatus === 'unknown_transfer') {
      weight += 40
      reasons.push('换岗连续性待澄清')
    }
    if (a.maturity === 'immature' && a.horizonDue.from - analysis.policy.reviewDay <= 3) {
      weight += 25
      reasons.push('三个统计日内进入观察期满点')
    }
    if (a.currentStatus === 'contact_interrupted') {
      weight += 30
      reasons.push('存在可核实联系中断')
    }
    if (a.currentStatus === 'no_receipt' || a.batchGapAffected) {
      reasons.push('来源缺口：限制结论，不形成个人落后标签')
    }

    priorities.push({
      worker: a.id,
      weight,
      reasons,
      hasOpenServiceCase: !!existingCase && !['已结案', '已结束'].includes(existingCase.stage),
      countyPlanTriggered: !!unit,
      eligibleForHelp: !!unit || !!existingCase,
      coverageGapOnly: weight === 0 && [
        'no_receipt',
        'unverified',
        'bounded_on_post',
        'report_verified_status_unknown',
      ].includes(a.currentStatus),
    })
  }
  return priorities
}
