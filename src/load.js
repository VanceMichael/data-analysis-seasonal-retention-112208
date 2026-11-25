import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDay } from './dates.js'

export const TABLE_NAMES = [
  'workers',
  'checks',
  'appointments',
  'limits',
  'authorizations',
  'contact_lists',
  'followup_cases',
]

export async function loadDataset(dir) {
  const root = dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
  const data = {}
  await Promise.all(TABLE_NAMES.map(async name => {
    const file = path.join(root, `${name}.json`)
    data[name] = JSON.parse(await readFile(file, 'utf8'))
  }))
  return data
}

export function validateDataset(data) {
  const errors = []
  const warnings = []
  const requireRows = name => {
    if (!Array.isArray(data[name]) || data[name].length === 0) {
      errors.push(`${name}: 表必须是非空数组`)
      return []
    }
    return data[name]
  }

  const workers = requireRows('workers')
  const checks = requireRows('checks')
  const appointments = requireRows('appointments')
  const limits = requireRows('limits')
  const authorizations = requireRows('authorizations')
  const contactLists = requireRows('contact_lists')
  const cases = requireRows('followup_cases')

  const workerIds = new Set()
  const firmIds = new Set()
  for (const w of workers) {
    if (workerIds.has(w.id)) errors.push(`workers: 重复编号 ${w.id}`)
    workerIds.add(w.id)
    if (w.firm) firmIds.add(w.firm)
    for (const key of ['first_report']) {
      try { parseDay(w[key], key) } catch (err) { errors.push(`workers.${w.id}.${key}: ${err.message}`) }
    }
  }

  for (const c of checks) {
    if (!workerIds.has(c.subject) && !firmIds.has(c.subject)) {
      errors.push(`checks.${c.check}: subject ${c.subject} 既不是工人也不是已出现企业`)
    }
    if (c.reference && /^F/.test(c.reference)) firmIds.add(c.reference)
    try {
      const from = parseDay(c.from, 'from')
      const to = parseDay(c.to, 'to')
      if (from !== null && to !== null && from > to) errors.push(`checks.${c.check}: from 晚于 to`)
    } catch (err) {
      errors.push(`checks.${c.check}: ${err.message}`)
    }
  }

  for (const a of appointments) {
    if (a.type === '个人' && !workerIds.has(a.target)) {
      errors.push(`appointments.${a.appt}: 个人预约目标 ${a.target} 不存在`)
    }
    if (a.type === '雇主' && !firmIds.has(a.target)) {
      errors.push(`appointments.${a.appt}: 雇主预约目标 ${a.target} 不存在`)
    }
  }

  const slots = new Set()
  for (const l of limits) {
    if (slots.has(l.slot)) errors.push(`limits: 时段 ${l.slot} 重复；当前实现期望每时段一条容量`)
    slots.add(l.slot)
    for (const key of ['capacity', 'review_day', 'horizon']) {
      try { parseDay(l[key], key) } catch (err) { errors.push(`limits.${l.slot}.${key}: ${err.message}`) }
    }
  }

  for (const a of authorizations) {
    if (!workerIds.has(a.worker)) errors.push(`authorizations: 工人 ${a.worker} 不存在`)
    if (!firmIds.has(a.source)) firmIds.add(a.source)
    if (!['授权', '撤回'].includes(a.state)) warnings.push(`authorizations.${a.worker}/${a.source}: 未识别状态 ${a.state}`)
  }

  for (const list of contactLists) {
    if (!firmIds.has(list.recipient)) errors.push(`contact_lists.${list.id}: 收件企业 ${list.recipient} 不存在`)
    for (const wid of String(list.workers || '').split('+').filter(Boolean)) {
      if (!workerIds.has(wid)) errors.push(`contact_lists.${list.id}: 成员 ${wid} 不存在`)
    }
  }

  for (const kase of cases) {
    if (!workerIds.has(kase.worker)) errors.push(`followup_cases.${kase.case}: 工人 ${kase.worker} 不存在`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
