import { canEmployerVerifyAt, employerGrant, effectiveContact, grantKey } from './permissions.js'

export class ContactListError extends Error {}

export function parseListWorkers(list) {
  return String(list.workers ?? '').split('+').filter(Boolean)
}

export function assessExistingLists(data, analysis, slot = '周五') {
  const { permissions } = analysis
  const currentEmployers = new Map()
  for (const a of analysis.assessments) currentEmployers.set(a.id, new Set(a.currentEmployerCandidates))

  return (data.contact_lists ?? []).map(list => {
    const workers = parseListWorkers(list)
    const memberAccess = workers.map(id => {
      const worker = analysis.byId.get(id)
      let decision
      if (!worker) {
        decision = { allowed: false, reason: 'worker_not_found' }
      } else if (slot) {
        decision = canEmployerVerifyAt(worker, list.recipient, slot, permissions, { currentEmployers })
      } else {
        const contact = effectiveContact(worker, permissions)
        const grant = employerGrant(id, list.recipient, permissions)
        const allowedFirms = currentEmployers.get(id)
        if (!contact.employerAllowed) decision = { allowed: false, reason: 'consent_not_employer' }
        else if (!grant.allowed) decision = grant
        else if (allowedFirms && !allowedFirms.has(list.recipient)) decision = { allowed: false, reason: 'not_current_employer' }
        else decision = { allowed: true, reason: null }
      }
      const history = permissions.authHistory.get(`${id}\u0000${list.recipient}`) ?? []
      const allowedAtIssuance = history.some(row => row.state === '授权') || decision.allowed
      return {
        worker: id,
        currentlyAllowed: decision.allowed,
        allowedAtIssuance,
        reason: decision.reason,
        grantKey: grantKey(id, list.recipient),
        retentionUseAllowed: decision.allowed || list.state === '已送'
          ? decision.allowed
          : false,
      }
    })
    return {
      ...list,
      workerIds: workers,
      frozen: list.state === '已送',
      canAddWorkers: list.state !== '已送',
      memberAccess,
      deniedMembers: memberAccess.filter(m => !m.currentlyAllowed).map(m => ({ worker: m.worker, reason: m.reason })),
    }
  })
}

export function buildAllowedEmployerList(firm, candidateIds, slot, analysis, options = {}) {
  const currentEmployers = new Map()
  for (const a of analysis.assessments) currentEmployers.set(a.id, new Set(a.currentEmployerCandidates))
  const allowed = []
  const denied = []
  for (const id of candidateIds) {
    const worker = analysis.byId.get(id)
    if (!worker) {
      denied.push({ worker: id, reason: 'worker_not_found' })
      continue
    }
    const decision = canEmployerVerifyAt(worker, firm, slot, analysis.permissions, { currentEmployers })
    if (decision.allowed) allowed.push(id)
    else denied.push({ worker: id, reason: decision.reason })
  }
  return {
    recipient: firm,
    department: options.department ?? null,
    day: options.day ?? slot ?? null,
    slot: slot ?? null,
    workers: allowed,
    denied,
    workersField: allowed.join('+'),
    scope: options.scope ?? '本厂在岗',
  }
}

export function createDraftList(id, firm, workerIds, at, analysis, slot, options = {}) {
  const allowed = buildAllowedEmployerList(firm, workerIds, slot, analysis, options)
  if (allowed.denied.length && options.strict !== false) {
    throw new ContactListError(`不能把未授权/不可核验成员加入跟访单: ${JSON.stringify(allowed.denied)}`)
  }
  return {
    id,
    recipient: firm,
    workers: allowed.workers.join('+'),
    workersField: allowed.workers.join('+'),
    at: String(at),
    state: '待送',
    slot,
    department: options.department ?? null,
    day: at,
    allowedWorkers: allowed.workers,
    denied: allowed.denied,
  }
}

export function addWorkers(list, workerIds, analysis, slot = list.slot) {
  if (list.state === '已送') {
    throw new ContactListError('已送出的跟访单已经冻结，撤回授权后也不能加人；请重新开具明细')
  }
  const current = parseListWorkers(list)
  const allowed = buildAllowedEmployerList(list.recipient, workerIds, slot, analysis)
  const invalid = allowed.denied
  if (invalid.length) throw new ContactListError(`加入失败: ${JSON.stringify(invalid)}`)
  const merged = [...new Set([...current, ...allowed.workers])]
  return { ...list, workers: merged.join('+'), workerIds: merged }
}

export function sendList(list) {
  if (list.state === '已送') return list
  return { ...list, state: '已送', sentAt: list.sentAt ?? list.at }
}

export function attachListResults(list, results, analysis) {
  const listWorkers = new Set(parseListWorkers(list))
  const checks = []
  const quarantined = []
  const rejected = []

  for (const [subject, result] of Object.entries(results)) {
    if (!listWorkers.has(subject)) {
      rejected.push({ subject, reason: 'subject_not_on_frozen_list' })
      continue
    }
    const gk = grantKey(subject, list.recipient, result.scope ?? '本厂在岗')
    const grant = employerGrant(subject, list.recipient, analysis.permissions, result.scope ?? '本厂在岗')
    const revoked = !grant.allowed || analysis.permissions.withdrawnGrantKeys.has(gk)
    const check = {
      check: result.check ?? `R-${list.id}-${subject}`,
      subject,
      from: String(result.from),
      to: String(result.to),
      type: result.type ?? '在岗',
      reference: list.recipient,
      source: result.source ?? '雇主核验',
      listId: list.id,
      grantKey: gk,
    }
    checks.push(check)
    if (revoked) quarantined.push({ check: check.check, subject, reason: grant.reason ?? 'use_not_permitted' })
  }

  return { checks, quarantined, rejected }
}
