#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadDataset } from '../src/load.js'
import { buildBundle, renderMarkdown } from '../src/report.js'

function parseArgs(argv) {
  const [command = 'report', ...rest] = argv
  const args = {
    command,
    data: 'data',
    json: false,
    out: null,
    minMature: 3,
    casePolicyPath: null,
    windowsPath: null,
    withdrawRecord: [],
  }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--json') args.json = true
    else if (token === '--data') args.data = rest[++i]
    else if (token === '--out') args.out = rest[++i]
    else if (token === '--case-policy') args.casePolicyPath = rest[++i]
    else if (token === '--windows') args.windowsPath = rest[++i]
    else if (token === '--withdraw-record') args.withdrawRecord.push(...rest[++i].split(',').filter(Boolean))
    else if (token === '--min-mature') args.minMature = Number(rest[++i])
  }
  return args
}

async function readJsonOption(file) {
  return JSON.parse(await readFile(path.resolve(file), 'utf8'))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const data = await loadDataset(path.resolve(args.data))
  const options = {
    minMature: args.minMature,
    withdrawnRecordIds: args.withdrawRecord,
  }
  if (args.casePolicyPath) options.casePolicy = await readJsonOption(args.casePolicyPath)
  if (args.windowsPath) options.windowOverrides = await readJsonOption(args.windowsPath)

  const bundle = buildBundle(data, options)

  if (args.command === 'validate') {
    console.log(JSON.stringify(bundle.validation, null, 2))
    if (!bundle.validation.ok) process.exitCode = 1
    return
  }

  if (args.command === 'schedule') {
    console.log(JSON.stringify({ schedule: bundle.schedule, outreach: bundle.outreach }, null, 2))
    return
  }

  if (args.command === 'stats') {
    const output = JSON.stringify(bundle.statistics, null, 2)
    if (args.out) {
      await mkdir(path.dirname(args.out), { recursive: true })
      await writeFile(args.out, output, 'utf8')
    } else {
      console.log(output)
    }
    return
  }

  if (args.command === 'analyze') {
    const output = args.json ? JSON.stringify(bundle, null, 2) : renderMarkdown(bundle)
    if (args.out) {
      await mkdir(path.dirname(args.out), { recursive: true })
      await writeFile(args.out, output, 'utf8')
    } else {
      console.log(output)
    }
    return
  }

  const markdown = renderMarkdown(bundle)
  if (args.out) {
    await mkdir(path.dirname(args.out), { recursive: true })
    await writeFile(args.out, markdown, 'utf8')
    const jsonOut = args.out.replace(/\.md$/i, '.json')
    await writeFile(jsonOut, JSON.stringify(bundle, null, 2), 'utf8')
    console.error(`已写入 ${args.out} 和 ${jsonOut}`)
  } else {
    console.log(markdown)
  }
}

main().catch(err => {
  console.error(err.stack || err.message)
  process.exit(1)
})
