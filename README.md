# 劳务外派成效的留岗估计与跟访顺序

就业日和回访日用季初日偏移，日期区间为闭区间。样本只使用匿名编号。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

horizon 是报到后天数，review_day 是统计截点。正式报到可被有日期区间的核实回执更正。跟访回执注明信息提供方及已查对象，整批漏报行只说明未收到资料。已预约优先计入当日可用次数。

- `workers.json` 记录字段为 `id`、`source`、`channel`、`first_report`、`firm`、`consent`、`week`。
- `checks.json` 记录字段为 `check`、`subject`、`from`、`to`、`type`、`reference`、`source`。
- `appointments.json` 记录字段为 `appt`、`slot`、`type`、`target`、`touch`、`state`。
- `limits.json` 记录字段为 `slot`、`capacity`、`review_day`、`horizon`。
- `authorizations.json` 记录字段为 `worker`、`source`、`scope`、`rev`、`state`。
- `contact_lists.json` 记录字段为 `id`、`recipient`、`workers`、`at`、`state`。
- `followup_cases.json` 记录字段为 `case`、`worker`、`stage`、`rule`、`owner`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 可复用工具

代码位于 `src/`，零第三方依赖：

- `load.js`：读取并校验七张来源表及引用。
- `dates.js`：闭区间、报到日可信区间和观察期计算。
- `permissions.js`：同意的联络方式、可拨打星期、雇主授权版本、用途撤回与证据可用性。
- `employment.js`：就业段、连续换岗、协议结束、主动离岗、联系中断、无回执、区间内在岗和未知换岗的区分。
- `stats.js`：按来源地、输送方式及交叉分组输出满期/未满期/退出/未解、留岗上下界、整批漏报、覆盖范围和比较登记条件；统计表不输出个人编号。
- `scheduler.js`：硬约束过滤、已约容量占用、雇主批量共享证据、按“可改变的评估/统计/服务决定”排序和去重。
- `contactLists.js`：企业跟访单、授权成员过滤、已送单据冻结、结果隔离。
- `cases.js`：县级帮扶触发、各乡阈值政策、原责任点保留和多来源去重。
- `sampling.js` / `outreach.js`：合法核验抽样框、补缺、本季已约保护和窗口调整后的可达性重算。
- `workflow.js`：结果重入、前后结论 diff、已处理联系对象、仍应保留预约；`report.js` / `bin/retention.js` 生成 JSON/Markdown。

### 命令

```sh
npm test
npm run validate
npm run schedule
npm run report
node bin/retention.js stats --json
node bin/retention.js report \
  --case-policy config/case-policy.example.json \
  --windows config/holiday-windows.example.json \
  --withdraw-record C10
```

`--case-policy` 必须传入各乡正式确认的 `lostContactDays` 或 `lostContactRegistrations`；仓库中的 example 只示范格式，不是已确认规则。

### Node API

```js
import { loadDataset, createSession } from './src/index.js'

const data = await loadDataset('./data')
const session = createSession(data, {
  minMature: 3,
  casePolicy: {
    townships: {
      乡甲: { lostContactDays: 7 },
      乡乙: { lostContactRegistrations: 2 },
    },
  },
})

const before = session.state.statistics
const result = session.ingest({
  checks: [{
    check: 'R1',
    subject: 'P1',
    from: '22',
    to: '25',
    type: '在岗',
    reference: 'F2',
    source: '个人回访',
  }],
  completeAppointments: ['A1'],
})

console.log(result.changedConclusions)
console.log(result.handledContacts)
console.log(session.state.schedule)
```

节假日窗口调整可调用 `session.adjustHolidayWindows({ P8: { slots: ['周四'], methods: ['雇主'] } })`；撤回用途可调用 `session.withdrawUses({ withdrawnRecordIds: ['C10'] })`。所有统计均从原始表和当前许可重新计算，不保留旧缓存结论。

## 当前合成数据的口径要点

- 岗位期限按实际报到日起算；若有 `核实报到` 区间，则保留 `[from, to]` 报到日不确定性。满期条件为 `review_day - 最晚可能报到日 >= horizon`。
- 已满期：P1、P2、P6、P7、P8；P3、P4、P5、P9、P10 尚未满 21 天观察期。
- P8 有期满后在岗凭证；P6 协议结束、P7 主动离岗；P1 的连续换岗可并入同一就业段，但换岗后到岗位期限之间仍待核验。
- P2 的 C2 是“无回执”而不是失联或脱岗；P2 对 F1 的当前授权已撤回，因此不能发起新的 F1 核验，旧单返回的 P2 结果也会被隔离且不进入新统计。
- P3 曾失联，但与后续 `在岗` 凭证重叠，当前结论改为在岗，历史联系中断仍保留。
- P5 只支持“在 `23–24` 区间内某个日期已在岗”，不能把它扩展成连续在岗到第 25 天。
- 基线分组中，乡甲满期 3 人：可确认稳定 0、退出 1、待澄清 2，可支持留岗率区间为 `0%–66.7%`；乡乙满期 2 人：稳定 1、协议结束 1，区间为 `50%`。覆盖、满期样本和授权登记条件未完全满足，因此不能对两组作简单排名。
- 调度基线保留周三 A1；周四派生 P9 个人核验（未知换岗且接近期满），A4 候补；周五选择 A3/F1 批量核验 P3+P8，A2/P3 个人电话因共享同一结论而不重复安排。P2 当前雇主授权已撤回，不能加入新单或用于新留岗统计。

操作端 JSON/Markdown 可包含匿名编号以便派单；`statistics` 对象只返回分组结果，设计上不输出个人编号。
