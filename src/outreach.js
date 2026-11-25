import { legalVerificationFrame } from './sampling.js'

function summarizeDimension(analysis, frame, schedule, dimension) {
  const reachable = new Set(frame.eligible.map(x => x.worker))
  const scheduledWorkers = new Set()
  for (const action of schedule.scheduled) for (const id of action.workerIds) scheduledWorkers.add(id)

  const groups = new Map()
  for (const a of analysis.assessments) {
    const name = dimension === 'source' ? a.worker.source : a.worker.channel
    if (!groups.has(name)) {
      groups.set(name, {
        group: name,
        openDecisionWorkers: 0,
        lawfullyReachableOpenWorkers: 0,
        scheduledOpenWorkers: 0,
        unreachableOpenWorkers: 0,
        unresolvedNeeds: 0,
        scheduledFreshNeeds: 0,
      })
    }
    const row = groups.get(name)
    const open = a.unresolvedNeeds.length > 0
    if (open) {
      row.openDecisionWorkers += 1
      row.unresolvedNeeds += a.unresolvedNeeds.length
      if (reachable.has(a.id)) row.lawfullyReachableOpenWorkers += 1
      else row.unreachableOpenWorkers += 1
      if (scheduledWorkers.has(a.id)) row.scheduledOpenWorkers += 1
    }
  }

  for (const action of schedule.scheduled) {
    for (const id of action.workerIds) {
      const a = analysis.assessmentById.get(id)
      if (!a) continue
      const name = dimension === 'source' ? a.worker.source : a.worker.channel
      const count = (action.freshNeeds ?? []).filter(key => key.endsWith(`:${id}`)).length
      groups.get(name).scheduledFreshNeeds += count
    }
  }

  return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group, 'zh'))
}

export function buildOutreach(analysis, schedule, caseEvaluation) {
  const frame = legalVerificationFrame(analysis)
  const reachable = new Set(frame.eligible.map(x => x.worker))
  const caseWorkers = []
  for (const c of caseEvaluation.preservedCases) {
    const eligible = frame.eligible.find(x => x.worker === c.worker)
    caseWorkers.push({
      case: c.case,
      worker: c.worker,
      owner: c.owner,
      stage: c.stage,
      rule: c.rule,
      lawfullyReachable: reachable.has(c.worker),
      slots: eligible?.slots ?? [],
      channels: eligible?.channels ?? [],
      reasonIfUnreachable: frame.excluded.find(x => x.worker === c.worker)?.reason ?? null,
      triggerRelationZh: '窗口调整后按新同意时段重算；无法合法联系只改变登记/触发可达性，不把覆盖不足记成个人脱岗。',
    })
  }

  return {
    frame,
    bySource: summarizeDimension(analysis, frame, schedule, 'source'),
    byChannel: summarizeDimension(analysis, frame, schedule, 'channel'),
    caseWorkers,
  }
}
