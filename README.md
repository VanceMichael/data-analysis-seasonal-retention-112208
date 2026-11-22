# 劳务外派成效的留岗估计与跟访顺序

就业日和回访日用季初日偏移，日期区间为闭区间。样本只使用匿名编号。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

horizon 是报到后天数，review_day 是统计截点。正式报到可被有日期区间的核实回执更正。跟访回执注明信息提供方及已查对象，整批漏报行只说明未收到资料。已预约优先计入当日可用次数。

- `workers.json` 记录字段为 `id`、`source`、`channel`、`first_report`、`firm`、`consent`、`week`。
- `checks.json` 记录字段为 `check`、`subject`、`from`、`to`、`type`、`reference`、`source`。
- `appointments.json` 记录字段为 `appt`、`slot`、`type`、`target`、`touch`、`state`。
- `limits.json` 记录字段为 `slot`、`capacity`、`review_day`、`horizon`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
