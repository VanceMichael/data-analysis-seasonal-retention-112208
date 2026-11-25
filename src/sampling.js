import { effectiveContact } from './permissions.js'
import { buildCandidateActions } from './scheduler.js'

export function legalVerificationFrame(analysis) {
  const { actions, blocked } = buildCandidateActions(analysis)
  const byWorker = new Map()
  for (const action of actions) {
    for (const id of action.workerIds) {
      if (!byWorker.has(id)) byWorker.set(id, { worker: id, slots: new Set(), channels: new Set(), actions: [] })
      const row = byWorker.get(id)
      row.slots.add(action.slot)
      row.channels.add(action.type)
      row.actions.push(action.actionKey)
    }
  }

  const eligible = []
  const excluded = []
  for (const a of analysis.assessments) {
    const frame = byWorker.get(a.id)
    const contact = effectiveContact(a.worker, analysis.permissions)
    if (frame) {
      eligible.push({
        worker: a.id,
        source: a.worker.source,
        channel: a.worker.channel,
        slots: [...frame.slots],
        channels: [...frame.channels],
        maturity: a.maturity,
        horizonStatus: a.horizonStatus,
        unresolvedNeedCount: a.unresolvedNeeds.length,
      })
    } else {
      let reason = 'no_lawful_verification_channel'
      if (contact.refused) reason = 'consent_refused'
      else if (!contact.slots.length) reason = 'missing_contact_window'
      else if (contact.employerAllowed && !contact.phoneAllowed) reason = 'employer_authorization_or_current_scope_missing'
      excluded.push({ worker: a.id, reason, contact })
    }
  }
  return { eligible, excluded, blockedAppointments: blocked }
}

export function buildNextSample(analysis, schedule, options = {}) {
  const frame = legalVerificationFrame(analysis)
  const protectedAppointments = schedule.retainedAppointments.map(a => a.apptId)
  const protectedWorkers = new Set(schedule.retainedAppointments.map(a => {
    const appt = analysis.data.appointments.find(x => x.appt === a.apptId)
    return appt?.target
  }).filter(Boolean))

  const groupDeficit = new Map()
  for (const a of analysis.assessments) {
    for (const dim of [`source:${a.worker.source}`, `channel:${a.worker.channel}`]) {
      if (!groupDeficit.has(dim)) groupDeficit.set(dim, { unresolved: 0, immature: 0 })
      const row = groupDeficit.get(dim)
      if (a.horizonStatus === 'unresolved') row.unresolved += 1
      if (a.maturity !== 'mature') row.immature += 1
    }
  }

  const ranked = frame.eligible
    .filter(w => !protectedWorkers.has(w.worker))
    .map(w => {
      const a = analysis.assessmentById.get(w.worker)
      const deficits = [
        groupDeficit.get(`source:${w.source}`),
        groupDeficit.get(`channel:${w.channel}`),
      ]
      const deficitScore = deficits.reduce((n, d) => n + (d?.unresolved ?? 0) * 12 + (d?.immature ?? 0) * 4, 0)
      const fillsGap = a.unresolvedNeeds.length > 0 || a.maturity !== 'mature' || a.stable === null
      return {
        ...w,
        fillsGap,
        priorityScore: deficitScore + a.unresolvedNeeds.reduce((n, x) => n + x.urgency / 10, 0),
        fills: [`source:${w.source}`, `channel:${w.channel}`],
      }
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || a.worker.localeCompare(b.worker))

  const gapCandidates = ranked.filter(w => w.fillsGap)
  const clearCandidates = ranked.filter(w => !w.fillsGap)
  const limit = options.supplementLimit ?? gapCandidates.length
  return {
    eligible: frame.eligible,
    protectedAppointments,
    protectedWorkers: [...protectedWorkers],
    supplements: gapCandidates.slice(0, limit),
    overflowGapCandidates: gapCandidates.slice(limit),
    otherLegalCandidates: clearCandidates,
    additionalCandidates: ranked.slice(limit),
    excludedFromLegalFrame: frame.excluded,
    ruleZh: '下期抽样只从当前同意、时段、授权和用途均合法的核验人群补缺；已约且用于本季评估的核验继续保留。',
  }
}
