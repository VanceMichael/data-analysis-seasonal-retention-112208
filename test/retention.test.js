import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  loadDataset,
  validateDataset,
  createSession,
  rebuild,
  addWorkers,
  buildAllowedEmployerList,
  createDraftList,
} from '../src/index.js'

const data = await loadDataset()

function byId(state) {
  return state.analysis.assessmentById
}

test('原始合成资料通过引用校验', () => {
  const result = validateDataset(data)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('区分满期稳定、退出、联系缺口、无回执、区间在岗和未知换岗', () => {
  const session = createSession(data)
  const a = byId(session.state)

  assert.equal(a.get('P8').maturity, 'mature')
  assert.equal(a.get('P8').horizonStatus, 'stable')
  assert.equal(a.get('P8').stable, true)

  assert.equal(a.get('P6').horizonStatus, 'exited_contract')
  assert.equal(a.get('P7').horizonStatus, 'exited_voluntary')
  assert.equal(a.get('P6').stable, false)

  assert.equal(a.get('P2').stable, null)
  assert.equal(a.get('P2').currentStatus, 'no_receipt')
  assert.equal(a.get('P2').activeContactInterruption, false)
  assert.equal(a.get('P2').noReceipt, true)
  assert.equal(a.get('P2').usableNoReceipt, true)

  assert.equal(a.get('P3').currentStatus, 'on_post')
  assert.equal(a.get('P3').hadContactGap, true)

  assert.equal(a.get('P5').currentStatus, 'bounded_on_post')
  assert.equal(a.get('P9').currentStatus, 'unknown_transfer')

  assert.equal(a.get('P10').maturity, 'immature')
  assert.equal(a.get('P9').maturity, 'immature')
  assert.equal(a.get('P1').spell.sameSpellAcrossTransfer, true)
  assert.deepEqual(a.get('P4').report, {
    from: 10,
    to: 13,
    baseline: 12,
    corrected: true,
    conflict: false,
    receipts: a.get('P4').report.receipts,
  })
})

test('分组统计给出留岗上下界、整批漏报和未满足比较条件，且不含个人编号', () => {
  const state = rebuild(data, { minMature: 3 })
  const source = Object.fromEntries(state.statistics.tables.source.map(row => [row.group, row]))

  assert.equal(source['乡甲'].maturity.mature, 3)
  assert.deepEqual(source['乡甲'].retentionAmongMature.lowerRate, 0)
  assert.deepEqual(source['乡甲'].retentionAmongMature.upperRate, 0.6667)
  assert.equal(source['乡乙'].retentionAmongMature.confirmedLower, 1)
  assert.equal(source['乡乙'].batchMissing.affected, 2)
  assert.equal(source['乡甲'].batchMissing.materialUnresolved, 2)

  const sourceComparison = state.statistics.comparisons.find(c => c.dimension === 'source')
  assert.equal(sourceComparison.canPointCompare, false)
  assert.ok(sourceComparison.conditions.some(c => c.code === 'followup_coverage_measured'))
  assert.equal(JSON.stringify(state.statistics).includes('"P1"'), false)
  assert.equal(JSON.stringify(state.statistics).includes('"worker"'), false)
})

test('调度优先保留已约时段、选择共享雇主核验，并把更高价值 P9 排在 A4 前', () => {
  const state = rebuild(data)
  const wed = state.schedule.slots.find(s => s.slot === '周三')
  const thu = state.schedule.slots.find(s => s.slot === '周四')
  const fri = state.schedule.slots.find(s => s.slot === '周五')

  assert.equal(wed.remaining, 0)
  assert.equal(wed.scheduled[0].apptId, 'A1')
  assert.equal(state.schedule.retainedAppointments[0].apptId, 'A1')

  assert.equal(thu.scheduled[0].target, 'P9')
  assert.ok(thu.scheduled[0].freshNeeds.includes('transfer_clarification:P9'))
  assert.equal(thu.waitlisted[0].apptId, 'A4')

  assert.equal(fri.scheduled[0].apptId, 'A3')
  assert.deepEqual(fri.scheduled[0].workerIds, ['P3', 'P8'])
  assert.ok(state.schedule.superseded.some(x => x.apptId === 'A2'))
})

test('已送跟访单冻结；撤回授权的 P2 不能加人，也不能用于新留岗结论', () => {
  const state = rebuild(data)
  const cl1 = state.contactLists.find(l => l.id === 'CL1')
  assert.equal(cl1.frozen, true)
  assert.equal(cl1.deniedMembers[0].worker, 'P2')
  assert.equal(cl1.memberAccess.find(m => m.worker === 'P2').allowedAtIssuance, true)
  assert.equal(cl1.memberAccess.find(m => m.worker === 'P2').retentionUseAllowed, false)

  assert.throws(() => addWorkers(cl1, ['P2'], state.analysis), /冻结/)

  const allowed = buildAllowedEmployerList('F1', ['P2', 'P3', 'P8'], '周五', state.analysis)
  assert.deepEqual(allowed.workers, ['P3', 'P8'])
  assert.equal(allowed.denied[0].worker, 'P2')

  const draft = createDraftList('CL-TEST', 'F1', ['P3', 'P8'], '30', state.analysis, '周五')
  assert.equal(draft.workersField, 'P3+P8')
  assert.throws(
    () => createDraftList('CL-BAD', 'F1', ['P2'], '30', state.analysis, '周五'),
    /未授权/,
  )
})

test('雇主单返回的撤回用途结果被隔离，不改变分析结论', () => {
  const session = createSession(data)
  const result = session.ingest({
    listResults: [{
      listId: 'CL1',
      results: {
        P2: { from: '26', to: '30', type: '在岗' },
        P99: { from: '26', to: '30', type: '在岗' },
      },
    }],
  })

  assert.equal(result.ingestionNotes[0].quarantined[0].subject, 'P2')
  assert.equal(result.ingestionNotes[0].rejected[0].subject, 'P99')
  const p2 = session.state.analysis.assessmentById.get('P2')
  assert.equal(p2.stable, null)
  assert.ok(p2.excludedEvidence.some(e => e.reason === 'grant_use_withdrawn'))
})

test('新证据重入后给出结论变化、已处理联系对象和仍保留预约', () => {
  const session = createSession(data)
  const result = session.ingest({
    checks: [{
      check: 'R-P1',
      subject: 'P1',
      from: '22',
      to: '25',
      type: '在岗',
      reference: 'F2',
      source: '个人回访',
    }],
  })

  const change = result.changedConclusions.find(c => c.worker === 'P1')
  assert.ok(change)
  assert.equal(change.changes.horizonStatus.before, 'unresolved')
  assert.equal(change.changes.horizonStatus.after, 'stable')
  assert.ok(result.handledContacts.some(h => h.worker === 'P1' && h.resolvedNeedKeys.includes('horizon_status:P1')))
  assert.ok(result.retainedAppointments.some(a => a.appt === 'A1' && a.mayCompleteIfResultAlreadyReturned))
})

test('同一工人的多个可核验来源只生成一个帮扶单元', () => {
  const cloned = structuredClone(data)
  cloned.checks.push({
    check: 'C-DUP-P1', subject: 'P1', from: '23', to: '24', type: '合同结束', reference: 'F2', source: '名册',
  }, {
    check: 'C-DUP-P1-2', subject: 'P1', from: '23', to: '25', type: '合同结束', reference: 'F2', source: '个人',
  })
  const state = rebuild(cloned)
  const units = state.caseEvaluation.assistanceUnits.filter(u => u.worker === 'P1')
  assert.equal(units.length, 1)
  assert.equal(units[0].assistanceCount, 1)
  assert.ok(units[0].triggers[0].evidence.length >= 2)
})

test('持续失联阈值由各乡规则提供；未配置时不自动发明触发', () => {
  const cloned = structuredClone(data)
  cloned.checks.push({ check: 'L1', subject: 'P4', from: '14', to: '18', type: '失联', reference: 'F2', source: '个人' })
  const unconfigured = rebuild(cloned)
  assert.equal(unconfigured.caseEvaluation.proposals.some(p => p.worker === 'P4'), false)

  const configured = rebuild(cloned, {
    casePolicy: { townships: { 乡乙: { lostContactDays: 5 } } },
  })
  assert.ok(configured.caseEvaluation.assistanceUnits.some(u => u.worker === 'P4'))
})

test('节假日窗口拆分后，F1 周五批量核验只剩 P3，P8 改走其他窗口', () => {
  const session = createSession(data)
  session.adjustHolidayWindows({ P8: { slots: ['周四'], methods: ['雇主'] } })
  const allowed = buildAllowedEmployerList('F1', ['P3', 'P8'], '周五', session.state.analysis)
  assert.deepEqual(allowed.workers, ['P3'])
  assert.equal(allowed.denied[0].worker, 'P8')
  assert.equal(allowed.denied[0].reason, 'outside_contact_window')
})

test('撤回某条用途记录后，统计重新计算且不保留旧结论', () => {
  const before = createSession(data)
  assert.equal(before.state.analysis.assessmentById.get('P8').horizonStatus, 'stable')
  before.withdrawUses({ withdrawnRecordIds: ['C10'] })
  assert.equal(before.state.analysis.assessmentById.get('P8').horizonStatus, 'unresolved')
  const source = Object.fromEntries(before.state.statistics.tables.source.map(r => [r.group, r]))
  assert.equal(source['乡乙'].horizonOutcomes.stable, 0)
  assert.equal(source['乡乙'].horizonOutcomes.unresolved, 1)
})
