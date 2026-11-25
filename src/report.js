import { validateDataset } from './load.js'
import { rebuild } from './workflow.js'

export function buildBundle(data, options = {}) {
  const validation = validateDataset(data)
  const state = rebuild(data, options)
  return {
    validation,
    policy: state.analysis.policy,
    workerAssessments: state.analysis.assessments.map(a => ({
      id: a.id,
      source: a.worker.source,
      channel: a.worker.channel,
      reportRange: a.report.corrected ? [a.report.from, a.report.to] : a.report.baseline,
      horizonDue: [a.horizonDue.from, a.horizonDue.to],
      maturity: a.maturity,
      maturityZh: a.maturityZh,
      horizonStatus: a.horizonStatus,
      horizonStatusZh: a.horizonStatusZh,
      stable: a.stable,
      currentStatus: a.currentStatus,
      currentStatusZh: a.currentStatusZh,
      sameSpellAcrossTransfer: a.spell.sameSpellAcrossTransfer,
      currentEmployerCandidates: a.currentEmployerCandidates,
      batchGapAffected: a.batchGapAffected,
      hadContactGap: a.hadContactGap,
      excludedEvidence: a.excludedEvidence,
    })),
    statistics: state.statistics,
    cases: state.caseEvaluation,
    priorities: [...state.priorities.values()],
    schedule: state.schedule,
    sampling: state.sampling,
    outreach: state.outreach,
    contactLists: state.contactLists,
  }
}

function pctText(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n')
  return [head, sep, body].filter(Boolean).join('\n')
}

export function renderMarkdown(bundle) {
  const lines = []
  lines.push('# 稳定就业评估与跟访调度报告')
  lines.push('')
  lines.push(`统计截点：第 ${bundle.policy.reviewDay} 天；岗位期限：实际报到后 ${bundle.policy.horizon} 天。满期条件为 \`review_day - 最晚可能报到日 >= horizon\`。日期区间均为闭区间。`)
  lines.push('')

  lines.push('## 一、合成分组统计')
  lines.push('')
  for (const dim of ['source', 'channel']) {
    const table = bundle.statistics.tables[dim]
    lines.push(`### 按${dim === 'source' ? '来源地' : '输送方式'}`)
    lines.push('')
    lines.push(mdTable(
      ['分组', '总人数', '满期', '未满期', '稳定下限', '退出', '满期待澄清', '留岗区间', '整批漏报影响/未解'],
      table.map(r => [
        r.group,
        r.total,
        r.maturity.mature,
        r.maturity.immature,
        r.horizonOutcomes.stable,
        r.horizonOutcomes.exitedTotal,
        r.horizonOutcomes.unresolved,
        `${pctText(r.retentionAmongMature.lowerRate)}–${pctText(r.retentionAmongMature.upperRate)}（n=${r.retentionAmongMature.denominator}）`,
        `${r.batchMissing.affected}/${r.batchMissing.materialUnresolved}`,
      ]),
    ))
    lines.push('')
  }

  lines.push('### 比较登记条件')
  lines.push('')
  for (const comp of bundle.statistics.comparisons) {
    lines.push(`- **${comp.dimension}**：${comp.messageZh}`)
    for (const c of comp.conditions) {
      const extra = c.overlap ? `；重叠区间 ${c.overlap.from}–${c.overlap.to}` : ''
      lines.push(`  - ${c.met ? '满足' : '未满足'}：\`${c.code}\`${extra}`)
    }
  }
  lines.push('')

  lines.push('## 二、调度明细（操作端使用编号，统计表不展示个人行）')
  lines.push('')
  for (const slot of bundle.schedule.slots) {
    lines.push(`### ${slot.slot}：容量 ${slot.capacity}，已占 ${slot.used}，剩余 ${slot.remaining}`)
    for (const a of slot.scheduled) {
      const target = a.kind === '雇主批量核验' ? `${a.target} → ${a.workerIds.join('+')}` : a.target
      lines.push(`- 安排 **${a.kind}**：${target}${a.apptId ? `（预约 ${a.apptId}）` : '（派生建议）'}；可改变：${a.decisions.join('、')}`)
    }
    for (const w of slot.waitlisted) {
      lines.push(`- 候补：${w.apptId ?? w.actionKey} → ${w.target}（${w.reasonZh}）`)
    }
    for (const n of slot.notNeeded ?? []) {
      lines.push(`- 暂不需要：${n.apptId ?? n.actionKey}（${n.reasonZh}）`)
    }
    lines.push('')
  }
  lines.push(`共享证据规则：${bundle.schedule.ruleZh}`)
  lines.push('')
  lines.push('### 分组可澄清能力')
  lines.push('')
  lines.push(mdTable(
    ['来源地', '有待决定对象', '合法可联系', '已排入核验', '无法合法联系', '将取得的新决定数'],
    bundle.outreach.bySource.map(r => [
      r.group,
      r.openDecisionWorkers,
      r.lawfullyReachableOpenWorkers,
      r.scheduledOpenWorkers,
      r.unreachableOpenWorkers,
      r.scheduledFreshNeeds,
    ]),
  ))
  lines.push('')
  lines.push(mdTable(
    ['输送方式', '有待决定对象', '合法可联系', '已排入核验', '无法合法联系', '将取得的新决定数'],
    bundle.outreach.byChannel.map(r => [
      r.group,
      r.openDecisionWorkers,
      r.lawfullyReachableOpenWorkers,
      r.scheduledOpenWorkers,
      r.unreachableOpenWorkers,
      r.scheduledFreshNeeds,
    ]),
  ))
  lines.push('')

  lines.push('## 三、跟访单、帮扶与抽样')
  lines.push('')
  for (const list of bundle.contactLists) {
    lines.push(`- ${list.id} → ${list.recipient}，成员 ${list.workers}，${list.state}，冻结=${list.frozen ? '是' : '否'}`)
    for (const denied of list.deniedMembers) lines.push(`  - 当前不得用于 ${denied.worker}：${denied.reason}`)
  }
  lines.push('')
  lines.push(`帮扶口径：${bundle.cases.publicPolicyZh}`)
  for (const c of bundle.cases.preservedCases) {
    lines.push(`- ${c.case}/${c.worker}：${c.stage}，责任点 ${c.owner}；原责任点继续，规则=${c.rule}`)
  }
  lines.push(`- 下期合法核验框：${bundle.sampling.eligible.length} 人可联系，${bundle.sampling.excludedFromLegalFrame.length} 人当前无合法渠道；补缺候选 ${bundle.sampling.supplements.length} 人；已约保护：${bundle.sampling.protectedAppointments.join('、') || '无'}。`)
  lines.push('')

  lines.push('## 四、个人结论口径（供驻点核查，不作为统计表展示）')
  lines.push('')
  lines.push(mdTable(
    ['编号', '满期状态', '岗位期限', '留岗', '当前状态', '同段换岗'],
    bundle.workerAssessments.map(a => [
      a.id,
      a.maturityZh,
      `${a.horizonDue[0]}–${a.horizonDue[1]}`,
      a.stable === null ? '待定' : a.stable ? '稳定' : '退出',
      a.currentStatusZh,
      a.sameSpellAcrossTransfer ? '是' : '',
    ]),
  ))
  lines.push('')
  return lines.join('\n')
}
