// Small interval helpers. Source day values stay as strings in the raw tables;
// parsed numbers are only used by the analysis layer.

export const MISSING_VALUE = '?'

export function parseDay(value, field = 'day') {
  if (value === undefined || value === null || value === MISSING_VALUE) return null
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    throw new TypeError(`${field} must be an integer day string or "?", got ${JSON.stringify(value)}`)
  }
  return Number(value)
}

export function parseClosedInterval(row, fromField = 'from', toField = 'to') {
  const from = parseDay(row?.[fromField], fromField)
  const to = parseDay(row?.[toField], toField)
  if (from === null || to === null) return null
  if (from > to) {
    throw new RangeError(`closed interval ${fromField}=${from} must not start after ${toField}=${to}`)
  }
  return { from, to }
}

export function containsDay(interval, day) {
  return !!interval && day >= interval.from && day <= interval.to
}

export function intervalsOverlap(a, b) {
  return !!a && !!b && a.from <= b.to && b.from <= a.to
}

export function intervalRelation(a, b) {
  if (!a || !b) return 'unknown'
  if (a.to < b.from) return 'before'
  if (a.from > b.to) return 'after'
  return 'overlaps'
}

export function minNumber(values) {
  const xs = values.filter(v => typeof v === 'number' && Number.isFinite(v))
  return xs.length ? Math.min(...xs) : null
}

export function maxNumber(values) {
  const xs = values.filter(v => typeof v === 'number' && Number.isFinite(v))
  return xs.length ? Math.max(...xs) : null
}

export function unionRange(ranges) {
  const xs = ranges.filter(Boolean)
  if (!xs.length) return null
  return { from: Math.min(...xs.map(r => r.from)), to: Math.max(...xs.map(r => r.to)) }
}

export function intersectionRange(ranges) {
  const xs = ranges.filter(Boolean)
  if (!xs.length) return null
  const from = Math.max(...xs.map(r => r.from))
  const to = Math.min(...xs.map(r => r.to))
  return from <= to ? { from, to } : null
}
