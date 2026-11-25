import { assessEmployment } from './employment.js'
import { buildStatistics } from './stats.js'
import { evaluateCases, buildServicePriorities } from './cases.js'
import { planSchedule } from './scheduler.js'
import { buildNextSample } from './sampling.js'
import { buildOutreach } from './outreach.js'
import { assessExistingLists, attachListResults } from './contactLists.js'

export function rebuild(data, options = {}) {
  const permissionOptions = {
    ...(options.permissionOptions ?? {}),
    windowOverrides: options.windowOverrides ?? options.permissionOptions?.windowOverrides,
    withdrawnUseKeys: [
      ...(options.permissionOptions?.withdrawnUseKeys ?? []),
      ...(options.withdrawnUseKeys ?? []),
    ],
    withdrawnRecordIds: [
      ...(options.permissionOptions?.withdrawnRecordIds ?? []),
      ...(options.withdrawnRecordIds ?? []),
    ],
    withdrawnListIds: [
      ...(options.permissionOptions?.withdrawnListIds ?? []),
      ...(options.withdrawnListIds ?? []),
    ],
  }
  const analysis = assessEmployment(data, { policy: options.policy, permissionOptions })
  const statistics = buildStatistics(analysis, { minMature: options.minMature ?? 3 })
  const caseEvaluation = evaluateCases(analysis, { casePolicy: options.casePolicy })
  const priorities = new Map(buildServicePriorities(analysis, caseEvaluation).map(p => [p.worker, p]))
  const schedule = planSchedule(analysis, { caseEvaluation, priorities, slotOrder: options.slotOrder })
  const sampling = buildNextSample(analysis, schedule, options.sampling ?? {})
  const outreach = buildOutreach(analysis, schedule, caseEvaluation)
  const contactLists = assessExistingLists(data, analysis, options.listSlot)
  return { data, options, analysis, statistics, caseEvaluation, priorities, schedule, sampling, outreach, contactLists }
}

export function createSession(data, options = {}) {
  let state = rebuild(structuredClone(data), options)
  const history = []
  let ingestSequence = 0

  return {
    get state() { return state },
    get data() { return state.data },
    rebuild(nextOptions = {}) {
      state = rebuild(state.data, { ...options, ...nextOptions })
      return state
    },
    adjustHolidayWindows(windowOverrides, note = '节假日联络窗调整') {
      const merged = { ...(options.windowOverrides ?? {}), ...windowOverrides }
      options = { ...options, windowOverrides: merged }
      state = rebuild(state.data, options)
      return state
    },
    withdrawUses(useOptions = {}) {
      options = {
        ...options,
        withdrawnUseKeys: [...new Set([...(options.withdrawnUseKeys ?? []), ...(useOptions.withdrawnUseKeys ?? [])])],
        withdrawnRecordIds: [...new Set([...(options.withdrawnRecordIds ?? []), ...(useOptions.withdrawnRecordIds ?? [])])],
        withdrawnListIds: [...new Set([...(options.withdrawnListIds ?? []), ...(useOptions.withdrawnListIds ?? [])])],
      }
      state = rebuild(state.data, options)
      return state
    },
    ingest(input = {}) {
      const before = state
      const nextData = structuredClone(before.data)
      const incomingChecks = []
      const ingestionNotes = []

      if (Array.isArray(input.checks)) {
        incomingChecks.push(...input.checks)
      }

      if (input.listResults) {
        for (const item of input.listResults) {
          const list = (nextData.contact_lists ?? []).find(l => l.id === item.listId)
          if (!list) throw new Error(`contact list not found: ${item.listId}`)
          const attached = attachListResults(list, item.results, before.analysis)
          incomingChecks.push(...attached.checks)
          ingestionNotes.push({ listId: item.listId, ...attached })
        }
      }

      ingestSequence += 1
      for (const [index, check] of incomingChecks.entries()) {
        if (!check.check) check.check = `INGEST-${ingestSequence}-${index + 1}`
        nextData.checks.push(check)
      }

      if (Array.isArray(input.completeAppointments)) {
        for (const appt of nextData.appointments ?? []) {
          if (input.completeAppointments.includes(appt.appt)) appt.state = '已完成'
        }
      }

      const after = rebuild(nextData, options)
      const beforeById = before.analysis.assessmentById
      const afterById = after.analysis.assessmentById
      const changedConclusions = []
      for (const [id, afterAssessment] of afterById) {
        const beforeAssessment = beforeById.get(id)
        const fields = ['maturity', 'stable', 'horizonStatus', 'currentStatus', 'stableBasis']
        const changes = {}
        for (const field of fields) {
          if (beforeAssessment?.[field] !== afterAssessment[field]) {
            changes[field] = { before: beforeAssessment?.[field] ?? null, after: afterAssessment[field] }
          }
        }
        const oldNeeds = new Set((beforeAssessment?.unresolvedNeeds ?? []).map(n => n.key))
        const newNeeds = new Set(afterAssessment.unresolvedNeeds.map(n => n.key))
        const resolvedNeedKeys = [...oldNeeds].filter(k => !newNeeds.has(k))
        const newNeedKeys = [...newNeeds].filter(k => !oldNeeds.has(k))
        if (Object.keys(changes).length || resolvedNeedKeys.length || newNeedKeys.length) {
          changedConclusions.push({ worker: id, changes, resolvedNeedKeys, newNeedKeys })
        }
      }

      const incomingSubjects = new Set(incomingChecks.map(c => c.subject))
      const handledContacts = []
      for (const id of incomingSubjects) {
        const change = changedConclusions.find(c => c.worker === id)
        const apptIds = (nextData.appointments ?? [])
          .filter(a => a.target === id || (a.type === '雇主' && incomingChecks.some(c => c.reference === a.target)))
          .map(a => a.appt)
        handledContacts.push({
          worker: id,
          evidence: incomingChecks.filter(c => c.subject === id).map(c => c.check),
          appointmentIds: apptIds,
          resolvedNeedKeys: change?.resolvedNeedKeys ?? [],
          changed: !!change && Object.keys(change.changes).length > 0,
        })
      }

      const retainedAppointments = (after.data.appointments ?? [])
        .filter(a => a.state === '已约')
        .map(a => {
          const targetHandled = handledContacts.some(h =>
            h.appointmentIds.includes(a.appt) && h.resolvedNeedKeys.length)
          return {
            appt: a.appt,
            slot: a.slot,
            type: a.type,
            target: a.target,
            keep: true,
            protectForSeasonEvaluation: true,
            mayCompleteIfResultAlreadyReturned: targetHandled,
            reasonZh: targetHandled
              ? '已有新证据处理其待澄清项；可核销结果，但已约记录保留用于本季评估'
              : '仍有未决结论或属于本季受保护预约',
          }
        })

      const changedServicePriorities = []
      for (const [worker, afterPriority] of after.priorities) {
        const beforePriority = before.priorities.get(worker)
        const changes = {}
        for (const field of ['weight', 'countyPlanTriggered', 'eligibleForHelp']) {
          if ((beforePriority?.[field] ?? null) !== (afterPriority[field] ?? null)) {
            changes[field] = { before: beforePriority?.[field] ?? null, after: afterPriority[field] ?? null }
          }
        }
        if (Object.keys(changes).length) changedServicePriorities.push({ worker, changes })
      }

      const beforeProposalWorkers = new Set(before.caseEvaluation.proposals.map(p => p.worker))
      const newCaseProposals = after.caseEvaluation.proposals.filter(p => !beforeProposalWorkers.has(p.worker))

      const result = {
        before,
        state: after,
        ingestionNotes,
        incomingChecks,
        changedConclusions,
        changedServicePriorities,
        newCaseProposals,
        handledContacts,
        retainedAppointments,
      }
      history.push(result)
      state = after
      return result
    },
    history,
  }
}
