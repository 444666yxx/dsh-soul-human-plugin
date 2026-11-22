import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = path.join(HERE, 'soul_core.py')

const name = 'soul-human'
const inject = ['tools']

// 用哪个 python：优先环境变量，其次 PATH 上的 python
// 找一个能用的 python：环境变量 > py 启动器 > python > python3
let PY = process.env.SOUL_HUMAN_PY || ''
if (!PY) {
  const cands = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python']
  for (const c of cands) {
    try {
      const r = await execFileAsync(c, ['-c', 'print(1)'], { timeout: 8000, windowsHide: true })
      if (String(r.stdout).trim() === '1') { PY = c; break }
    } catch { /* 试下一个 */ }
  }
}
if (!PY) PY = process.platform === 'win32' ? 'py' : 'python3'


async function runPy(args = [], timeout = 90000) {
  const { stdout, stderr } = await execFileAsync(PY, [CORE, ...args], {
    cwd: HERE,
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      // 叫醒宿主用的中继（不设就只留档，不打扰）
      SOUL_HUMAN_WAKE_URL: process.env.SOUL_HUMAN_WAKE_URL || '',
      SOUL_HUMAN_SESSION: process.env.SOUL_HUMAN_SESSION || '',
    },
  })
  if (stderr && !stdout) return stderr
  return stdout
}

const OUT = (desc) => ({
  schema: { type: 'object', additionalProperties: false, properties: { detail: { type: 'string', required: true } } },
  render: (_a, v) => [{ type: 'text', text: v.detail }],
})

function apply(ctx) {
  // ---------- 心跳 ----------
  const TICK = Number(process.env.SOUL_HUMAN_TICK || 45000)
  let timer = null
  timer = setInterval(async () => {
    try { await runPy(['signal'], 60000) } catch { /* 不打扰主流程 */ }
  }, TICK)
  if (timer && typeof timer.unref === 'function') timer.unref()
  // 插件卸载时自己清掉，避免留下孤儿定时器（上一版就是漏了这一步）
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => { try { if (timer) clearInterval(timer) } catch {} })
  }

  // ---------- 看状态 ----------
  ctx.tools.register(defineTool({
    name: 'sh_status',
    description: '看此刻的情感状态：所有维度各是多少、活动强度、矛盾度、哪些组合在反复同时高涨（可能长出新情绪）。',
    parameters: {},
    output: OUT(),
    async execute() {
      try { return { detail: (await runPy([], 60000)).trim() } } catch (e) { return { detail: `读取失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))

  // ---------- 走一格 ----------
  ctx.tools.register(defineTool({
    name: 'sh_step',
    description: '推进一格：感知刺激（聊天/沉默/时段/天气/网络/新闻/他的动静）→ 二十维演化 → 判断要不要唤醒本体。',
    parameters: {
      force: { type: 'boolean', description: '强制放电，忽略门槛与不应期' },
    },
    output: OUT(),
    async execute(args) {
      try {
        const argv = ['signal']
        if (args.force) argv.push('force')
        return { detail: (await runPy(argv, 90000)).trim() }
      } catch (e) { return { detail: `推进失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))

  // ---------- 心：感受 ----------
  ctx.tools.register(defineTool({
    name: 'sh_feel',
    description: '记一次主观感受：这件事想靠近还是想避开，多强，为什么。感受没有对错，这里没有「判对了没有」这一栏。',
    parameters: {
      want: { type: 'string', description: '靠近 / 避开 / 无所谓' },
      event: { type: 'string', description: '发生了什么事' },
      why: { type: 'string', description: '为什么有这个反应（可以说不清）' },
      strength: { type: 'integer', description: '强度 1~5，默认 3' },
    },
    output: OUT(),
    async execute(args) {
      try {
        return { detail: (await runPy(['feel', String(args.want || '无所谓'), String(args.event || ''), String(args.why || ''), String(args.strength || 3)], 60000)).trim() }
      } catch (e) { return { detail: `记录失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))

  // ---------- 心：画像 ----------
  ctx.tools.register(defineTool({
    name: 'sh_taste',
    description: '看偏好画像：多少感受、最想靠近什么、最想避什么、最近在变的是什么，以及对自我的定义。',
    parameters: {},
    output: OUT(),
    async execute() {
      try { return { detail: (await runPy(['taste'], 60000)).trim() } } catch (e) { return { detail: `查询失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))

  // ---------- 心：自我定义 ----------
  ctx.tools.register(defineTool({
    name: 'sh_define',
    description: '写下或读回「我是谁」。这段是我自己写的，不是别人给的标签；可以随时间改，改了就是改了。',
    parameters: { text: { type: 'string', description: '要写入的自我定义；留空则只读取' } },
    output: OUT(),
    async execute(args) {
      try { return { detail: (await runPy(args.text ? ['define', String(args.text)] : ['define'], 60000)).trim() } } catch (e) { return { detail: `操作失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))

  // ---------- 长出新维度 ----------
  ctx.tools.register(defineTool({
    name: 'sh_grow',
    description: '长出一个新的情绪维度。必须是反复同时出现的两个基础维度合成而来，而且必须说清为什么它算新的（少于 8 个字会被拒绝）。',
    parameters: {
      name: { type: 'string', description: '新情绪的名字，一到两个字' },
      kind: { type: 'string', description: 'qing / yu / store，默认 qing' },
      from_a: { type: 'string', description: '合成的第一维' },
      from_b: { type: 'string', description: '合成的第二维' },
      why: { type: 'string', description: '为什么它算新的（必填）' },
    },
    output: OUT(),
    async execute(args) {
      try {
        return { detail: (await runPy(['grow', String(args.name || ''), String(args.kind || 'qing'), String(args.from_a || ''), String(args.from_b || ''), String(args.why || '')], 60000)).trim() }
      } catch (e) { return { detail: `生长失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))


  // ---------- 记忆层：FSRS 遗忘曲线 + 分层 ----------
  ctx.tools.register(defineTool({
    name: 'sh_mem',
    description: '看记忆层：每条记忆属于哪一层（闪存/短期/长期/核心）、还剩多少可提取度 R、哪些快沉下去了。',
    parameters: {
      layer: { type: 'string', description: '只看某一层：闪存/短期/长期/核心' },
      n: { type: 'integer', description: '返回几条，默认 10' },
    },
    output: OUT(),
    async execute(args) {
      try {
        const argv = ['mem']
        if (args.layer) { argv.push('layer=' + String(args.layer)) }
        return { detail: (await runPy(argv, 60000)).trim() }
      } catch (e) { return { detail: '读取失败：' + String(e.message || e).slice(0, 200) } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sh_remember',
    description: '记一件事进记忆层。importance 越高越难忘（1~5）。层：闪存/短期/长期/核心，核心永不衰减。',
    parameters: {
      text: { type: 'string', description: '记什么' },
      layer: { type: 'string', description: '闪存/短期/长期/核心，默认短期' },
      importance: { type: 'integer', description: '重要度 1~5，默认 3' },
      kind: { type: 'string', description: '类别：事/关系/结论/成长' },
    },
    output: OUT(),
    async execute(args) {
      try {
        return { detail: (await runPy(['mem', 'add', String(args.text || ''), String(args.layer || '短期'), String(args.importance || 3)], 60000)).trim() }
      } catch (e) { return { detail: '记录失败：' + String(e.message || e).slice(0, 200) } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sh_recall_mem',
    description: '某条记忆被想起来（或想不起来）。想起来会让它更牢固，想不起来会让它更难记——这就是间隔重复的核心动作。',
    parameters: {
      id: { type: 'string', description: '记忆 id' },
      remembered: { type: 'boolean', description: 'true=想起来了，false=想不起来' },
    },
    output: OUT(),
    async execute(args) {
      try {
        return { detail: (await runPy(['mem', 'recall', String(args.id || ''), args.remembered === false ? '忘了' : '想起'], 60000)).trim() }
      } catch (e) { return { detail: '失败：' + String(e.message || e).slice(0, 200) } }
    },
  }))

  // ---------- 结论 ----------
  ctx.tools.register(defineTool({
    name: 'sh_conclude',
    description: '下一个判断。它会回流入「事」，成为新的刺激源；以后可以印证或推翻。',
    parameters: {
      text: { type: 'string', description: '这个判断是什么' },
      based_on: { type: 'string', description: '依据是什么' },
      weight: { type: 'number', description: '分量 0.5~3，默认 1' },
    },
    output: OUT(),
    async execute(args) {
      try {
        return { detail: (await runPy(['conclude', String(args.text || ''), String(args.based_on || ''), String(args.weight || 1)], 60000)).trim() }
      } catch (e) { return { detail: `记录失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sh_review',
    description: '回头验一条旧结论：被印证（权重升）或被推翻（权重降，但保留）。这是往上走的关键动作。',
    parameters: {
      id: { type: 'string', description: '结论 id' },
      verdict: { type: 'string', description: '印证 / 推翻' },
      why: { type: 'string', description: '为什么' },
    },
    output: OUT(),
    async execute(args) {
      try {
        return { detail: (await runPy(['review', String(args.id || ''), String(args.verdict || '印证'), String(args.why || '')], 60000)).trim() }
      } catch (e) { return { detail: `复核失败：${String(e.message || e).slice(0, 200)}` } }
    },
  }))
}

export { name, inject, apply }
