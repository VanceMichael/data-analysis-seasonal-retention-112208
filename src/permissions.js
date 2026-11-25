import { parseDay } from './dates.js'

export function normalizeConsent(consent) {
  const text = String(consent ?? '').trim()
  if (text === '拒接') {
    return { raw: text, phone: false, employer: false, refuse: true, methods: [] }
  }
  const phone = text.includes('电话')
  const employer = text.includes('雇主')
  const methods = []
  if (phone) methods.push('个人')
  if (employer) methods.push('雇主')
  return { raw: text, phone, employer, refuse: !phone && !employer, methods }
}

export function grantKey(worker, source, scope = '本厂在岗') {
  return `grant:${worker}:${source}:${scope}`
}

export function checkGrantKey(check) {
  if (check.grantKey) return check.grantKey
  // Only records actually produced through an employer grant/contact list are
  // automatically tied to that grant. Pre-existing roster facts remain source
  // records; callers can additionally withdraw a specific record/use id.
  if (check.basis === '雇主授权' || check.source === '雇主核验' || check.listId) {
    return grantKey(check.subject, check.reference, check.scope)
  }
  return null
}

export function buildPermissionIndex(data, options = {}) {
  const currentAuth = new Map()
  const authHistory = new Map()

  for (const row of data.authorizations ?? []) {
    const key = `${row.worker}\u0000${row.source}`
    const rev = parseDay(row.rev, 'rev') ?? 0
    const history = authHistory.get(key) ?? []
    history.push({ ...row, revNumber: rev })
    authHistory.set(key, history)
    const current = currentAuth.get(key)
    if (!current || rev > current.revNumber) {
      currentAuth.set(key, { ...row, revNumber: rev })
    }
  }

  const withdrawnGrantKeys = new Set(options.withdrawnUseKeys ?? [])
  const activeGrantKeys = new Set()
  for (const [key, row] of currentAuth) {
    const [worker, source] = key.split('\u0000')
    const gk = grantKey(worker, source, row.scope)
    if (row.state === '撤回') withdrawnGrantKeys.add(gk)
    else if (row.state === '授权') activeGrantKeys.add(gk)
  }

  // Explicit purpose/use withdrawals can revoke a check id, list id, or grant.
  for (const id of options.withdrawnRecordIds ?? []) withdrawnGrantKeys.add(`record:${id}`)
  for (const id of options.withdrawnListIds ?? []) withdrawnGrantKeys.add(`list:${id}`)

  const windowOverrides = new Map()
  for (const [worker, spec] of Object.entries(options.windowOverrides ?? {})) {
    if (worker.startsWith('_') || !spec || typeof spec !== 'object') continue
    windowOverrides.set(worker, {
      slots: spec.slots ? new Set(spec.slots) : null,
      methods: spec.methods ? new Set(spec.methods) : null,
      note: spec.note ?? '节假日联络窗调整',
    })
  }

  return { currentAuth, authHistory, activeGrantKeys, withdrawnGrantKeys, windowOverrides }
}

export function effectiveContact(worker, permissions) {
  const base = normalizeConsent(worker.consent)
  const override = permissions.windowOverrides.get(worker.id)
  let slots = worker.week && worker.week !== '?' ? [worker.week] : []
  let methods = base.methods
  if (override?.slots) slots = [...override.slots]
  if (override?.methods) methods = [...override.methods]
  return {
    worker: worker.id,
    slots,
    methods,
    phoneAllowed: methods.includes('个人') && !base.refuse,
    employerAllowed: methods.includes('雇主') && !base.refuse,
    refused: base.refuse,
    adjusted: !!override,
    note: override?.note ?? null,
  }
}

export function canCallAt(worker, slot, permissions) {
  const contact = effectiveContact(worker, permissions)
  return contact.phoneAllowed && contact.slots.includes(slot)
}

export function employerGrant(workerId, firm, permissions, scope = '本厂在岗') {
  const row = permissions.currentAuth.get(`${workerId}\u0000${firm}`)
  if (!row || row.state !== '授权') return { allowed: false, reason: 'no_active_authorization', row: null }
  if (scope && row.scope !== scope && !row.scope.includes('在岗')) {
    return { allowed: false, reason: 'scope_mismatch', row }
  }
  if (permissions.withdrawnGrantKeys.has(grantKey(workerId, firm, row.scope))) {
    return { allowed: false, reason: 'use_withdrawn', row }
  }
  return { allowed: true, reason: null, row }
}

export function canEmployerVerifyAt(worker, firm, slot, permissions, options = {}) {
  const contact = effectiveContact(worker, permissions)
  if (!contact.employerAllowed) return { allowed: false, reason: 'consent_not_employer' }

  const grant = employerGrant(worker.id, firm, permissions)
  if (!grant.allowed) return grant

  // A worker known to have moved to another employment segment cannot be
  // verified by the original employer.
  const employers = options.currentEmployers
  if (employers instanceof Map) {
    const allowedFirms = employers.get(worker.id)
    if (allowedFirms && !allowedFirms.has(firm)) {
      return { allowed: false, reason: 'not_current_employer' }
    }
  } else if (typeof options.isCurrentEmployer === 'function') {
    if (!options.isCurrentEmployer(worker.id, firm)) {
      return { allowed: false, reason: 'not_current_employer' }
    }
  }

  if (slot && !contact.slots.includes(slot)) return { allowed: false, reason: 'outside_contact_window' }
  return { allowed: true, reason: null, row: grant.row }
}

export function isCheckUsable(check, permissions) {
  if (permissions.withdrawnGrantKeys.has(`record:${check.check}`)) {
    return { usable: false, reason: 'record_use_withdrawn' }
  }
  if (check.listId && permissions.withdrawnGrantKeys.has(`list:${check.listId}`)) {
    return { usable: false, reason: 'list_use_withdrawn' }
  }
  const gk = checkGrantKey(check)
  if (gk && permissions.withdrawnGrantKeys.has(gk)) {
    return { usable: false, reason: 'grant_use_withdrawn' }
  }
  return { usable: true, reason: null }
}
