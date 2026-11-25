import { canCallAt, canEmployerVerifyAt, effectiveContact } from './permissions.js'
import { buildServicePriorities, evaluateCases } from './cases.js'

function priorityMap(analysis, options) {
  if (options.priorities instanceof Map) return options.priorities
  const cases = options.caseEvaluation ?? evaluateCases(analysis, options.caseOptions ?? {})
  return new Map(buildServicePriorities(analysis, cases).map(p => [p.worker, p]))
}

function actionNeedScore(action, analysis, priorities, addressedNeeds) {
  let score = 0
  const decisions = new Set()
  const freshNeeds = []
  for (const workerId of action.workerIds) {
    const a = analysis.assessmentById.get(workerId)
    if (!a) continue
    const workerFreshNeeds = []
    for (const need of a.unresolvedNeeds) {
      if (addressedNeeds.has(need.key)) continue
      if (action.canAddressNeed(need, a)) {
        workerFreshNeeds.push(need)
        freshNeeds.push(need.key)
        score += need.urgency
        decisions.add(need.decision)
        decisions.add(`stat:source:${a.worker.source}`)
        decisions.add(`stat:channel:${a.worker.channel}`)
      }
    }
    if (workerFreshNeeds.length) {
      // The worker contributes to two overlapping synthetic tables; count this
      // once per worker rather than once per overlapping need.
      score += 20
      const priority = priorities.get(workerId)
      if (priority?.weight) {
        const serviceWeight = Math.min(45, Math.round(priority.weight * 0.35))
        score += serviceWeight
        decisions.add(`service:${workerId}`)
      }
    }
  }
  return { score, freshNeeds, decisions: [...decisions] }
}

function actionHasAnyOpenNeed(action, analysis) {
  for (const workerId of action.workerIds) {
    const a = analysis.assessmentById.get(workerId)
    if (!a) continue
    if (a.unresolvedNeeds.some(need => action.canAddressNeed(need, a))) return true
  }
  return false
}

function personalAction(worker, slot, analysis, source = {}) {
  const allowed = canCallAt(worker, slot, analysis.permissions)
  if (!allowed) return null
  const a = analysis.assessmentById.get(worker.id)
  return {
    actionKey: `personal:${worker.id}:${slot}`,
    kind: '个人核验',
    type: '个人',
    slot,
    target: worker.id,
    workerIds: [worker.id],
    firm: null,
    apptId: source.apptId ?? null,
    candidate: source.candidate ?? false,
    held: source.held ?? false,
    touchCost: source.touchCost ?? 1,
    canAddressNeed: need => need.worker === worker.id,
    compliant: true,
    assessment: a,
  }
}

function employerAction(firm, slot, workerIds, analysis, source = {}) {
  const currentEmployers = new Map()
  for (const a of analysis.assessments) currentEmployers.set(a.id, new Set(a.currentEmployerCandidates))
  const allowedWorkers = []
  const denied = []
  for (const id of workerIds) {
    const w = analysis.byId.get(id)
    if (!w) continue
    const result = canEmployerVerifyAt(w, firm, slot, analysis.permissions, { currentEmployers })
    if (result.allowed) allowedWorkers.push(id)
    else denied.push({ worker: id, reason: result.reason })
  }
  if (!allowedWorkers.length) {
    return {
      actionKey: `employer:${firm}:${slot}:${source.apptId ?? 'generated'}`,
      kind: '雇主批量核验', type: '雇主', slot, target: firm, firm,
      workerIds: [], denied, apptId: source.apptId ?? null,
      candidate: source.candidate ?? false, held: source.held ?? false,
      touchCost: source.touchCost ?? 1, compliant: false,
      canAddressNeed: () => false,
    }
  }
  return {
    actionKey: `employer:${firm}:${slot}`,
    kind: '雇主批量核验',
    type: '雇主',
    slot,
    target: firm,
    firm,
    workerIds: [...new Set(allowedWorkers)],
    denied,
    apptId: source.apptId ?? null,
    candidate: source.candidate ?? false,
    held: source.held ?? false,
    touchCost: source.touchCost ?? 1,
    compliant: denied.length === 0,
    canAddressNeed: (need, assessment) => {
      if (!['horizon_status', 'pre_horizon_status', 'transfer_clarification'].includes(need.kind)) return false
      return assessment.currentEmployerCandidates.includes(firm) &&
        (!need.firms?.length || need.firms.includes(firm) || need.kind !== 'transfer_clarification')
    },
  }
}

export function buildCandidateActions(analysis, options = {}) {
  const actions = []
  const blocked = []
  const seen = new Set()
  const appointments = analysis.data.appointments ?? []

  // Existing appointment records.
  for (const appt of appointments) {
    const cost = Number(appt.touch ?? 1)
    if (appt.type === '个人') {
      const w = analysis.byId.get(appt.target)
      if (!w) continue
      const action = personalAction(w, appt.slot, analysis, {
        apptId: appt.appt,
        candidate: appt.state === '候选',
        held: appt.state === '已约',
        touchCost: cost,
      })
      if (action) {
        actions.push(action)
        seen.add(action.actionKey)
      } else {
        blocked.push({ apptId: appt.appt, slot: appt.slot, target: appt.target, type: appt.type, reason: 'outside_consented_method_or_window' })
      }
    } else if (appt.type === '雇主') {
      // A candidate employer appointment does not enumerate people. Find every
      // currently authorized/current worker that the firm could cover.
      const candidates = analysis.assessments
        .filter(a => a.currentEmployerCandidates.includes(appt.target))
        .map(a => a.id)
      const action = employerAction(appt.target, appt.slot, candidates, analysis, {
        apptId: appt.appt,
        candidate: appt.state === '候选',
        held: appt.state === '已约',
        touchCost: cost,
      })
      if (action.workerIds.length) {
        actions.push(action)
        seen.add(action.actionKey)
      } else {
        blocked.push({
          apptId: appt.appt,
          slot: appt.slot,
          target: appt.target,
          type: appt.type,
          reason: action.denied[0]?.reason ?? 'no_authorized_worker',
          denied: action.denied,
        })
      }
    }
  }

  // Lawful generated personal actions for unresolved needs.
  for (const a of analysis.assessments) {
    const w = a.worker
    const contact = effectiveContact(w, analysis.permissions)
    for (const slot of contact.slots) {
      const key = `personal:${w.id}:${slot}`
      if (seen.has(key)) continue
      const action = personalAction(w, slot, analysis)
      if (action) {
        actions.push(action)
        seen.add(key)
      }
    }
  }

  // Lawful generated employer batches from active grants.
  const firmSlotWorkers = new Map()
  for (const grant of analysis.permissions.currentAuth.values()) {
    if (grant.state !== '授权') continue
    const w = analysis.byId.get(grant.worker)
    if (!w) continue
    const contact = effectiveContact(w, analysis.permissions)
    for (const slot of contact.slots) {
      const key = `${grant.source}\u0000${slot}`
      if (!firmSlotWorkers.has(key)) firmSlotWorkers.set(key, new Set())
      firmSlotWorkers.get(key).add(grant.worker)
    }
  }
  for (const [key, ids] of firmSlotWorkers) {
    const [firm, slot] = key.split('\u0000')
    const actionKey = `employer:${firm}:${slot}`
    if (seen.has(actionKey)) continue
    const action = employerAction(firm, slot, [...ids], analysis)
    if (action.workerIds.length) {
      actions.push(action)
      seen.add(actionKey)
    }
  }

  return { actions, blocked }
}

export function planSchedule(analysis, options = {}) {
  const priorities = priorityMap(analysis, options)
  const { actions: rawActions, blocked } = buildCandidateActions(analysis, options)
  const slotOrder = options.slotOrder ?? [...analysis.policy.slots.keys()]
  const capacityBySlot = new Map(slotOrder.map(slot => [slot, analysis.policy.slots.get(slot)?.capacity ?? 1]))
  const usedCapacity = new Map(slotOrder.map(slot => [slot, 0]))
  const scheduled = []
  const waitlisted = []
  const superseded = []
  const notNeeded = []
  const addressedNeeds = new Set(options.initialAddressedNeeds ?? [])
  const heldRows = (analysis.data.appointments ?? []).filter(a => a.state === '已约')
  for (const appt of heldRows) {
    usedCapacity.set(appt.slot, (usedCapacity.get(appt.slot) ?? 0) + Number(appt.touch ?? 1))
  }

  // Feasible held appointments are retained and their pending needs are treated
  // as already-being-acquired. Invalid held rows still consumed capacity above
  // and are reported as compliance exceptions.
  const held = rawActions.filter(a => a.held)
  const feasibleHeldIds = new Set(held.map(a => a.apptId))
  const complianceExceptions = heldRows
    .filter(appt => !feasibleHeldIds.has(appt.appt))
    .map(appt => ({
      apptId: appt.appt,
      slot: appt.slot,
      target: appt.target,
      type: appt.type,
      reasonZh: '该已约记录不符合当前同意方式、时段、授权或当前雇主范围；时段仍保留占用，需人工改期或补授权',
    }))

  for (const action of held) {
    const scoring = actionNeedScore(action, analysis, priorities, addressedNeeds)
    action.score = scoring.score
    action.freshNeeds = scoring.freshNeeds
    action.decisions = scoring.decisions
    for (const key of scoring.freshNeeds) addressedNeeds.add(key)
    scheduled.push(action)
  }

  const retainedAppointments = heldRows.map(appt => ({
    apptId: appt.appt,
    slot: appt.slot,
    target: appt.target,
    kind: appt.type,
    compliant: feasibleHeldIds.has(appt.appt),
    reasonZh: '已预约时段优先占用，并保留用于本季项目评估',
  }))

  const candidates = rawActions.filter(a => !a.held).map(action => {
    const scoring = actionNeedScore(action, analysis, priorities, addressedNeeds)
    return { ...action, score: scoring.score, freshNeeds: scoring.freshNeeds, decisions: scoring.decisions }
  })

  // Global value ordering; ties prefer broader shared evidence, then existing candidates.
  candidates.sort((a, b) =>
    b.score - a.score ||
    b.decisions.length - a.decisions.length ||
    b.workerIds.length - a.workerIds.length ||
    Number(!!b.apptId) - Number(!!a.apptId) ||
    a.actionKey.localeCompare(b.actionKey))

  for (const action of candidates) {
    const fresh = actionNeedScore(action, analysis, priorities, addressedNeeds)
    action.score = fresh.score
    action.freshNeeds = fresh.freshNeeds
    action.decisions = fresh.decisions

    if (!fresh.freshNeeds.length) {
      if (actionHasAnyOpenNeed(action, analysis)) {
        superseded.push({
          apptId: action.apptId,
          actionKey: action.actionKey,
          slot: action.slot,
          target: action.target,
          workerIds: action.workerIds,
          reasonZh: '同一结论或可共享证据已由另一次核验覆盖，不重复获取',
        })
      } else {
        notNeeded.push({
          apptId: action.apptId,
          actionKey: action.actionKey,
          slot: action.slot,
          target: action.target,
          workerIds: action.workerIds,
          reasonZh: '现有可核实记录已足够支持当前结论，不再占用跟访次数',
        })
      }
      continue
    }

    const used = usedCapacity.get(action.slot) ?? 0
    const capacity = capacityBySlot.get(action.slot) ?? 1
    if (used + action.touchCost <= capacity) {
      usedCapacity.set(action.slot, used + action.touchCost)
      scheduled.push(action)
      for (const key of fresh.freshNeeds) addressedNeeds.add(key)
    } else {
      waitlisted.push({
        apptId: action.apptId,
        actionKey: action.actionKey,
        slot: action.slot,
        target: action.target,
        workerIds: action.workerIds,
        score: action.score,
        reasonZh: '该时段容量已由已约或更高共享价值核验占用',
      })
    }
  }

  const slots = slotOrder.map(slot => ({
    slot,
    capacity: capacityBySlot.get(slot) ?? 1,
    used: usedCapacity.get(slot) ?? 0,
    remaining: Math.max(0, (capacityBySlot.get(slot) ?? 1) - (usedCapacity.get(slot) ?? 0)),
    scheduled: scheduled.filter(a => a.slot === slot).map(publicAction),
    waitlisted: waitlisted.filter(a => a.slot === slot),
    notNeeded: notNeeded.filter(a => a.slot === slot),
  }))

  return {
    slots,
    scheduled: scheduled.map(publicAction),
    waitlisted,
    superseded,
    notNeeded,
    blocked,
    complianceExceptions,
    retainedAppointments,
    addressedNeeds: [...addressedNeeds],
    ruleZh: '先满足同意方式/时段/授权/当前雇主等硬约束，再按一次核验能改变的留岗判断、分组统计和服务决定排序；共享雇主证据只获取一次。',
  }
}

function publicAction(a) {
  return {
    apptId: a.apptId,
    actionKey: a.actionKey,
    kind: a.kind,
    type: a.type,
    slot: a.slot,
    target: a.target,
    firm: a.firm,
    workerIds: a.workerIds,
    denied: a.denied ?? [],
    score: a.score,
    freshNeeds: a.freshNeeds,
    decisions: a.decisions,
    candidate: a.candidate,
    held: a.held,
  }
}
