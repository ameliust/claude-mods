import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Group, Turn } from '../types'

// What this does: watches what Claude is actually sent, without changing any of
// it. Every hook calls next(e) and returns its answer untouched.
//   prompt.compose    -> the system prompt, section by section (id, scope, text)
//   prompt.context    -> the context blocks the first user message carries
//   prompt.attachment -> each injected message (the text inside a <system-reminder>)
//   turn.start        -> numbers the main loop's turns, so reminders group by turn
// Each hook also reads next.trace, the chain beneath it, to say which plugin
// added, edited or removed a section, block or reminder on its way out. It sees
// only the plugins beneath it: one seated above prompt-glimpse is invisible.
// A pane shows one group at a time (tabs on top), each row collapsed. With
// debugLog on, each new prompt version, context set and distinct reminder is
// also written as its own numbered file under <logDir>/<session id>/.

const PANE = 'prompt-glimpse'
const MAX_REMINDERS = 300
const MAX_TURNS = 200
const SHOWN_TURNS = 40
const MAX_SHOWN_LINES = 400
// Past this many lines an expanded row gets a second collapse button at its end,
// so a long section can be closed without scrolling back up.
const FOOTER_AFTER_LINES = 25

const system = atom({ plugin: 'prompt-glimpse', key: 'system' } as const, [])
const context = atom({ plugin: 'prompt-glimpse', key: 'context' } as const, [])
const reminders = atom({ plugin: 'prompt-glimpse', key: 'reminders' } as const, [])
const turns = atom({ plugin: 'prompt-glimpse', key: 'turns' } as const, [])
const traits = atom({ plugin: 'prompt-glimpse', key: 'traits' } as const, [])
const header = atom({ plugin: 'prompt-glimpse', key: 'header' } as const, '')
const open = atom({ plugin: 'prompt-glimpse', key: 'open' } as const, [])
const tab = atom({ plugin: 'prompt-glimpse', key: 'tab' } as const, 'system')

const TITLES: Record<Group, string> = {
  system: 'System prompt',
  context: 'Context',
  reminders: 'Reminders',
  turns: 'Turns',
}

// Row keys stay short: every key in the pane's tree counts toward the 100,000
// characters a drawing may carry, and keys that held whole reminder texts used
// that up, so rows past the first were left out and the pane stopped working.
const hash = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${(h >>> 0).toString(16)}.${s.length}`
}
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)
const now = () => new Date().toISOString()
const clock = (iso: string) => iso.slice(11, 19)
// A rough size: about four characters to a token for English prose and code.
const tokens = (chars: number) =>
  chars < 4000 ? `~${Math.max(1, Math.round(chars / 4))} tok` : `~${(chars / 4000).toFixed(1)}k tok`
// A fixed log scale, so a row's bar means the same in every tab and one huge
// row does not flatten the rest: one cell from 1 token, then 20, 100, 500, 2.5k.
const BAR_STEPS = [1, 20, 100, 500, 2500]
const bar = (chars: number) => {
  const tok = chars / 4
  const n = BAR_STEPS.filter(s => tok >= s).length
  return '█'.repeat(n) + '·'.repeat(BAR_STEPS.length - n)
}
// The quiet part of a row's line. Older stored rows carried their size, the
// default "engine" origin and a full agent id in it; the row now shows the
// size itself, so those are trimmed here as well as no longer written.
const tidy = (meta: string) =>
  meta
    .split(' · ')
    .filter(p => p !== 'engine' && !/^~[\d.]+k? tok$/.test(p))
    .map(p => p.replace(/^agent (\w{4})\w*$/, 'agent $1'))
    .join(' · ')
const agentTag = (agentId: string | undefined) => (agentId ? `agent ${agentId.slice(0, 4)}` : '')
// A one-line peek at a text, to tell versions of one reminder apart.
const peek = (text: string) => {
  const flat = text.replace(/<\/?[\w-]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat || '(empty)'
}

// ---- provenance: who changed what beneath us -------------------------------

type Item = { key: string; text: string }
type Layer = { plugin: string; items: Item[] }
type Provenance = { tags: Map<string, string[]>; removed: { key: string; text: string; by: string }[] }

// next.trace lists the links beneath a hook nearest first, the engine last;
// turned around, each layer is what one link handed up.
function layersOf<O>(trace: readonly { plugin: string; returned: O | undefined }[], items: (o: O) => Item[]): Layer[] {
  const layers: Layer[] = []
  for (const t of [...trace].reverse()) {
    if (t.returned === undefined) continue
    layers.push({ plugin: t.plugin, items: items(t.returned) })
  }
  return layers
}

function provenance(layers: Layer[]): Provenance {
  const tags = new Map<string, string[]>()
  const removed: Provenance['removed'] = []
  const tag = (key: string, what: string) => tags.set(key, [...(tags.get(key) ?? []), what])
  for (let i = 1; i < layers.length; i++) {
    const below = new Map(layers[i - 1]!.items.map(x => [x.key, x.text]))
    const here = layers[i]!
    if (here.plugin === 'engine') continue
    const kept = new Set<string>()
    for (const x of here.items) {
      kept.add(x.key)
      const was = below.get(x.key)
      if (was === undefined) tag(x.key, `added by ${here.plugin}`)
      else if (was !== x.text) tag(x.key, `edited by ${here.plugin}`)
    }
    for (const [key, text] of below) if (!kept.has(key)) removed.push({ key, text, by: here.plugin })
  }
  return { tags, removed }
}

// ---- versions: what each row was before its latest change ------------------

function buildVersion(
  previous: Entry[],
  group: 'system' | 'context',
  items: { key: string; text: string; meta: string }[],
  prov: Provenance,
  showDiff: boolean,
  at: string,
): Entry[] {
  const fresh: Entry[] = items.map(x => {
    const key = `${group}:${x.key}`
    const old = previous.find(p => p.key === key && p.gone === undefined)
    const entry: Entry = {
      key,
      label: x.key,
      meta: x.meta,
      text: x.text,
      at: old && old.text === x.text ? old.at : at,
      lastAt: at,
      count: 1,
      by: prov.tags.get(x.key),
    }
    if (showDiff && old && old.text !== x.text) {
      entry.prevText = old.text
      entry.prevAt = old.at
    } else if (showDiff && old) {
      entry.prevText = old.prevText
      entry.prevAt = old.prevAt
    }
    return entry
  })
  const present = new Set(fresh.map(x => x.key))
  const removed: Entry[] = prov.removed.map(r => ({
    key: `${group}:${r.key}`,
    label: r.key,
    meta: '',
    text: r.text,
    at,
    lastAt: at,
    count: 1,
    gone: `removed by ${r.by}`,
  }))
  for (const r of removed) present.add(r.key)
  const dropped: Entry[] = []
  if (showDiff) {
    for (const p of previous) {
      if (present.has(p.key)) continue
      if (p.gone === undefined) dropped.push({ ...p, gone: `not sent since ${clock(at)}`, lastAt: at })
      else if (p.gone.startsWith('not sent')) dropped.push(p)
      present.add(p.key)
    }
  }
  return [...fresh, ...removed, ...dropped]
}

// A unified diff (longest common subsequence over lines), as hunks with two
// lines of context, for the pane's Code element to draw with its own gutters.
type DiffLine = { sign: ' ' | '+' | '-'; line: string; i: number; j: number }

function unifiedDiff(before: string, after: string): string | undefined {
  // Code takes tab and newline as its only control characters.
  const clean = (t: string) => t.replace(/[^\t\n\P{Cc}]/gu, '').split('\n')
  const a = clean(before)
  const b = clean(after)
  if (a.length * b.length > 2_000_000) return undefined
  // lcs[i * w + j]: the longest common run of a[i..] and b[j..].
  const w = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * w)
  const at = (i: number, j: number) => lcs[i * w + j]!
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ sign: ' ', line: a[i]!, i, j })
      i++
      j++
    } else if (j < b.length && (i === a.length || at(i, j + 1) >= at(i + 1, j))) {
      all.push({ sign: '+', line: b[j]!, i, j })
      j++
    } else {
      all.push({ sign: '-', line: a[i]!, i, j })
      i++
    }
  }
  const near = all.map((_, k) => all.slice(Math.max(0, k - 2), k + 3).some(x => x.sign !== ' '))
  const hunks: string[] = []
  for (let k = 0; k < all.length; ) {
    if (!near[k]) {
      k++
      continue
    }
    const start = k
    while (k < all.length && near[k]) k++
    const run = all.slice(start, k)
    const old = run.filter(x => x.sign !== '+').length
    const neu = run.filter(x => x.sign !== '-').length
    const first = run[0]!
    hunks.push(
      [
        `@@ -${old ? first.i + 1 : first.i},${old} +${neu ? first.j + 1 : first.j},${neu} @@`,
        ...run.map(x => `${x.sign}${x.line}`),
      ].join('\n'),
    )
  }
  return hunks.join('\n')
}

// ---- module state; a reload starts it over (the pane's data lives in $.state)

let isLogging = false
let showDiff = false
let logOption = ''
let baseDir: string | undefined
let sessionDir: string | undefined
let fileCount: number | undefined
let counting: Promise<void> | undefined
let lastPromptSig = ''
let lastContextSig = ''

async function dirs($: EngineInterface) {
  if (sessionDir !== undefined) return sessionDir
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  baseDir = (logOption !== '' ? logOption : `${home}/.claude/prompt-glimpse-logs`).replace(/\\/g, '/')
  sessionDir = `${baseDir}/${await $.session.id()}`
  return sessionDir
}

// Numbers continue from the highest file already in the folder, so a reload
// or a resumed session never writes over an earlier file.
async function countFiles($: EngineInterface, dir: string) {
  let highest = 0
  try {
    for (const f of await $.fs.list(dir)) {
      const m = /^(\d+)-/.exec(f.name)
      if (m) highest = Math.max(highest, Number(m[1]))
    }
  } catch {
    // no folder yet
  }
  fileCount = highest
}

// Never throws: a log that cannot be written must not cost the pane its rows.
async function writeLog($: EngineInterface, name: string, head: string, text: string) {
  if (!isLogging) return
  let file = name
  try {
    const dir = await dirs($)
    if (fileCount === undefined) {
      counting ??= countFiles($, dir)
      await counting
    }
    fileCount = (fileCount ?? 0) + 1
    file = `${dir}/${String(fileCount).padStart(4, '0')}-${fileSafe(name)}.md`
    await $.fs.write(file, `${head}\n\n${text}\n`)
  } catch (err) {
    void $.ui.log(`prompt-glimpse: could not write the log file ${file}: ${String(err)}`)
  }
}

// ---- recording ---------------------------------------------------------------

type Section = { id: string; text: string; scope: string }

async function recordPrompt(
  $: EngineInterface,
  e: { model: string; promptModel: string; tools: readonly string[]; traits: readonly string[] },
  sections: readonly Section[],
  layers: Layer[],
) {
  const prov = provenance(layers)
  const sig = [
    ...sections.map(s => `${s.id}\u0000${s.scope}\u0000${s.text}`),
    ...prov.removed.map(r => `-${r.key}\u0000${r.by}`),
  ].join('\u0001')
  if (sig === lastPromptSig) return
  lastPromptSig = sig
  const at = now()
  const items = sections.map((s, i) => ({
    key: s.id,
    text: s.text,
    meta: `${s.scope} · #${i + 1}`,
  }))
  await update($, system, previous => buildVersion(previous, 'system', items, prov, showDiff, at))
  await update($, traits, () => [...e.traits])
  const model = e.promptModel === e.model ? e.model : `${e.model} (prompt of ${e.promptModel})`
  await update($, header, () => `${model} · ${e.tools.length} tools`)
  const removedNote = prov.removed.map(r => `<!-- removed: ${r.key} by ${r.by} -->`).join('\n')
  const whole = sections
    .map(s => {
      const by = prov.tags.get(s.id)
      return `<!-- section: ${s.id} (${s.scope}, ${s.text.length} chars${by ? `, ${by.join(', ')}` : ''}) -->\n${s.text}`
    })
    .join('\n\n')
  await writeLog(
    $,
    'system-prompt',
    `# System prompt\n\n${at} · model ${model} · ${e.tools.length} tools · traits [${e.traits.join(', ')}] · ${sections.length} sections`,
    removedNote ? `${removedNote}\n\n${whole}` : whole,
  )
}

async function recordContext($: EngineInterface, blocks: readonly { name: string; text: string }[], layers: Layer[]) {
  const prov = provenance(layers)
  const sig = [...blocks.map(b => `${b.name}\u0000${b.text}`), ...prov.removed.map(r => `-${r.key}`)].join('\u0001')
  if (sig === lastContextSig) return
  lastContextSig = sig
  const at = now()
  const items = blocks.map(b => ({ key: b.name, text: b.text, meta: '' }))
  await update($, context, previous => buildVersion(previous, 'context', items, prov, showDiff, at))
  await writeLog(
    $,
    'context',
    `# Context blocks\n\n${at}`,
    [
      ...prov.removed.map(r => `<!-- removed: ${r.key} by ${r.by} -->`),
      ...blocks.map(b => {
        const by = prov.tags.get(b.name)
        return `<!-- block: ${b.name}${by ? ` (${by.join(', ')})` : ''} -->\n${b.text}`
      }),
    ].join('\n\n'),
  )
}

// Reminders arrive in bursts (one request carries many), each from its own
// dispatch, and a dispatch reads $.state at one fixed moment: a hook that
// read-modify-writes the list never sees what the others wrote meanwhile, so
// rows were lost (or the engine gave up retrying). The list therefore lives
// here in the module, the one source of truth, and is written whole with
// $.state.set, which needs no read; one loop writes each burst.
type Pending = {
  type: string
  agentId?: string
  origin: string
  text: string
  by: string[]
  dropped?: string
  at: string
}

let pending: Pending[] = []
let flushing: Promise<void> | undefined
let reminderList: Entry[] = []
let turnNo = 0
let loading: Promise<void> | undefined

// After a reload the module starts empty; pick the pane's data back up once.
async function loadMirror($: EngineInterface) {
  loading ??= (async () => {
    // Entries from before keys were hashed carry their whole text; drop them.
    reminderList = (await read($, reminders)).filter(x => x.key.length <= 200)
    turnNo = Math.max(turnNo, (await read($, turns)).at(-1)?.n ?? 0)
  })()
  await loading
}

function mergeReminders(batch: Pending[], turn: number): Pending[] {
  const added: Pending[] = []
  for (const p of batch) {
    const key = `reminder:${p.type}:${p.agentId ?? ''}:${p.dropped ? 'dropped' : ''}:${hash(p.text)}`
    const k = reminderList.findIndex(x => x.key === key)
    if (k >= 0) {
      const x = reminderList[k]!
      const seen = x.turns ?? []
      reminderList[k] = {
        ...x,
        count: x.count + 1,
        lastAt: p.at,
        turns: seen[seen.length - 1] === turn ? seen : [...seen, turn].slice(-50),
      }
      continue
    }
    added.push(p)
    reminderList.push({
      key,
      label: p.type,
      meta: [p.origin === 'engine' ? '' : p.origin, agentTag(p.agentId)].filter(Boolean).join(' · '),
      text: p.text,
      at: p.at,
      lastAt: p.at,
      count: 1,
      by: p.by.length > 0 ? p.by : undefined,
      gone: p.dropped,
      turns: [turn],
    })
  }
  reminderList = reminderList.slice(-MAX_REMINDERS)
  return added
}

async function flushReminders($: EngineInterface) {
  while (pending.length > 0) {
    const batch = pending
    pending = []
    const turn = turnNo
    const added = mergeReminders(batch, turn)
    await $.state.set({ plugin: 'prompt-glimpse', key: 'reminders' }, reminderList)
    for (const p of added) {
      const where = p.agentId ? ` · agent ${p.agentId}` : ''
      const how = [...p.by, ...(p.dropped ? [p.dropped] : [])].join(', ')
      await writeLog(
        $,
        `reminder-${p.type}`,
        `# Reminder: ${p.type}

${p.at} · turn ${turn} · ${p.origin}${where}${how ? ` · ${how}` : ''}`,
        p.text,
      )
    }
  }
}

async function queueReminder($: EngineInterface, p: Pending) {
  await loadMirror($)
  pending.push(p)
  // Loop, so an entry queued just as a flush finished is not left waiting
  // for the next reminder to come along.
  while (pending.length > 0 || flushing !== undefined) {
    flushing ??= flushReminders($).finally(() => {
      flushing = undefined
    })
    await flushing
  }
}

let awaitingStart = false

async function startTurn($: EngineInterface, text: string) {
  try {
    await loadMirror($)
    turnNo += 1
    const turn: Turn = { n: turnNo, at: now(), text: text.replace(/\s+/g, ' ').slice(0, 80) }
    await update($, turns, list => [...list.filter(t => t.n < turn.n), turn].slice(-MAX_TURNS))
  } catch (err) {
    await $.ui.log(`prompt-glimpse: could not number the turn: ${String(err)}`)
  }
}

async function exportSnapshot($: EngineInterface) {
  const dir = await dirs($)
  const at = now()
  const [sys, ctx, rem, ts, tr, head] = [
    await read($, system),
    await read($, context),
    await read($, reminders),
    await read($, turns),
    await read($, traits),
    await read($, header),
  ]
  const lastTurn = ts.at(-1)?.n ?? 0
  const block = (x: Entry) =>
    `### ${x.label}${x.gone ? ` (${x.gone}, not sent)` : ''}\n\n<!-- ${x.meta}${x.by ? ` · ${x.by.join(', ')}` : ''} -->\n\n${x.text}`
  const total = (xs: Entry[]) => tokens(xs.filter(x => !x.gone).reduce((n, x) => n + x.text.length, 0))
  const latest = rem.filter(x => x.turns?.includes(lastTurn))
  const text = [
    `# Prompt glimpse snapshot`,
    `${at} · ${head} · traits [${tr.join(', ')}]`,
    `System ${total(sys)} · context ${total(ctx)} · reminders of turn ${lastTurn} ${total(latest)}. Sizes are estimates at four characters a token.`,
    `## System prompt`,
    ...sys.map(block),
    `## Context blocks`,
    ...ctx.map(block),
    `## Reminders injected in turn ${lastTurn}`,
    ...latest.map(block),
    `## Every distinct reminder this session (${rem.length})`,
    ...rem.map(x => `- ${x.label} ×${x.count}, ${clock(x.at)}–${clock(x.lastAt)}, ${x.meta}`),
  ].join('\n\n')
  const file = `${dir}/snapshot-${at.replace(/[:.]/g, '-')}.md`
  try {
    await $.fs.write(file, `${text}\n`)
    $.ui.toast(`Snapshot written to ${file}`)
  } catch (err) {
    $.ui.toast(`Could not write the snapshot: ${String(err)}`)
  }
}

async function resetPane($: EngineInterface) {
  reminderList = []
  await $.state.set({ plugin: 'prompt-glimpse', key: 'reminders' }, [])
  await $.state.set({ plugin: 'prompt-glimpse', key: 'open' }, [])
  await $.state.set({ plugin: 'prompt-glimpse', key: 'tab' }, 'system')
}

// ---- hooks -------------------------------------------------------------------

export const register: Register = (on, options) => {
  isLogging = options.debugLog === true
  showDiff = options.showDiff === true
  logOption = typeof options.logDir === 'string' ? options.logDir : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-glimpse',
      description: 'Show the system prompt sections and reminders Claude is sent',
    })
    void $.ui.open({ id: PANE, title: 'Prompt glimpse' })
    return next(e)
  })

  on('command.run', { command: 'prompt-glimpse' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Prompt glimpse' })
    return { text: isLogging ? `Prompt glimpse opened. Logging to ${await dirs($)}` : 'Prompt glimpse opened.' }
  })

  // A turn is numbered when its prompt is submitted, before the engine builds
  // that prompt's reminders: numbering at turn.start raced them, so a burst
  // split across two turns. turn.start numbers only a turn no prompt began
  // (a continuation); a prompt delivered into a running turn joins that turn.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      awaitingStart = true
      await startTurn($, e.text)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (awaitingStart) awaitingStart = false
      else await startTurn($, e.text)
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    // `analysis` is a /context measurement that sends nothing; skip it.
    if (e.traits.includes('analysis')) return result
    try {
      const layers = layersOf(next.trace, r => r.sections.map(s => ({ key: s.id, text: s.text })))
      await recordPrompt($, e, result.sections, layers)
    } catch (err) {
      await $.ui.log(`prompt-glimpse: could not record the system prompt: ${String(err)}`)
    }
    return result
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    try {
      const layers = layersOf(next.trace, r => r.blocks.map(b => ({ key: b.name, text: b.text })))
      await recordContext($, result.blocks, layers)
    } catch (err) {
      await $.ui.log(`prompt-glimpse: could not record the context: ${String(err)}`)
    }
    return result
  })

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    try {
      // Walk the chain bottom up to say who edited or dropped the text.
      const by: string[] = []
      let original = ''
      let last: string | null | undefined
      let dropper = ''
      for (const t of [...next.trace].reverse()) {
        if (t.returned === undefined) continue
        const text = t.returned.text
        if (last === undefined) {
          if (text !== null) original = text
        } else if (text !== last && t.plugin !== 'engine') {
          if (text === null) dropper = t.plugin
          else by.push(last === null ? `restored by ${t.plugin}` : `edited by ${t.plugin}`)
        }
        if (text !== null) original = text
        last = text
      }
      const shown = result.text ?? original
      await queueReminder($, {
        type: e.type,
        agentId: e.agentId,
        origin: e.origin.kind === 'engine' ? 'engine' : `${e.origin.kind}:${e.origin.event}`,
        text: shown || '(empty)',
        by,
        dropped: result.text === null ? (dropper ? `dropped by ${dropper}` : 'dropped') : undefined,
        at: now(),
      })
    } catch (err) {
      await $.ui.log(`prompt-glimpse: could not record a reminder: ${String(err)}`)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Code draws a framed, monospaced block (and a real diff); a surface
    // without it gets plain text.
    const Code = 'Code' in elements ? elements.Code : undefined
    // A drawing that throws would leave the pane blank with no word why; draw
    // the error instead, with a way out if the stored data is what breaks it.
    try {
      return await drawPane()
    } catch (err) {
      void $.ui.log(`prompt-glimpse: could not draw the pane: ${String(err)}`)
      return (
        <Box flexDirection="column">
          <Text color="error">prompt-glimpse could not draw: {String(err)}</Text>
          <Button key="reset" onPress={() => void resetPane($)}>
            Clear the pane's data
          </Button>
        </Box>
      )
    }

    async function drawPane() {
      const opened = new Set(await read($, open))
      const shownTraits = await read($, traits)
      const shownHeader = await read($, header)
      const current = await read($, tab)
      const turnList = await read($, turns)
      const byGroup: Record<Exclude<Group, 'turns'>, Entry[]> = {
        system: await read($, system),
        context: await read($, context),
        reminders: await read($, reminders),
      }
      const toggle = (key: string) => () =>
        void update($, open, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
      const pick = (group: Group) => () => void update($, tab, () => group)
      const collapseAll = () => void update($, open, () => [])
      const sent = (xs: Entry[]) => xs.filter(x => x.gone === undefined)
      const chars = (xs: Entry[]) => sent(xs).reduce((n, x) => n + x.text.length, 0)
      const lastTurn = turnList.at(-1)?.n ?? 0
      const inTurn = (n: number) => byGroup.reminders.filter(x => (x.turns ?? [0]).includes(n))
      // Reminders of one type, in order of first appearance: a type whose text
      // changes every turn (the token countdown) is one row, not forty.
      const kinds = (() => {
        const m = new Map<string, Entry[]>()
        for (const x of byGroup.reminders) m.set(x.label, [...(m.get(x.label) ?? []), x])
        return [...m].map(([label, xs]) => ({ label, xs }))
      })()
      const counts: Record<Group, string> = {
        system: tokens(chars(byGroup.system)).replace(' tok', ''),
        context: tokens(chars(byGroup.context)).replace(' tok', ''),
        reminders: String(kinds.length),
        turns: String(turnList.length),
      }
      const span = (from: string, to: string) => (clock(from) === clock(to) ? clock(from) : `${clock(from)}–${clock(to)}`)

      // The one line every row starts with: a small toggle, the size bar, the
      // name, then the quiet details and any notes. Only the toggle is a
      // button, so the list reads as a list and not as a wall of buttons.
      const headLine = (spec: {
        rowKey: string
        size: number
        label: string
        meta: string
        notes?: string[]
        quote?: string
        gone?: boolean
        mono?: boolean
      }) => {
        const filled = bar(spec.gone ? 0 : spec.size)
        const lit = filled.replace(/·/g, '')
        return (
          <Box flexDirection="row" gap={1}>
            <Button key={`row:${spec.rowKey}`} plain dimColor onPress={toggle(spec.rowKey)}>
              {opened.has(spec.rowKey) ? '▾' : '▸'}
            </Button>
            <Text>
              <Text mono color={spec.gone ? 'inactive' : 'claude'}>
                {'━'.repeat(lit.length)}
              </Text>
              <Text mono color="subtle">
                {'━'.repeat(BAR_STEPS.length - lit.length)}
              </Text>{' '}
              <Text weight="medium" mono={spec.mono} strikethrough={spec.gone} dimColor={spec.gone}>
                {spec.label}
              </Text>
              {spec.quote !== undefined && (
                <Text italic dimColor>
                  {' '}
                  {spec.quote}
                </Text>
              )}
              <Text size="footnote" dimColor tabular>
                {'  '}
                {spec.meta}
              </Text>
              {spec.notes && spec.notes.length > 0 && (
                <Text size="footnote" color="warning">
                  {'  '}
                  {spec.notes.join(' · ')}
                </Text>
              )}
            </Text>
          </Box>
        )
      }

      // An open row's body: its actions, then its text (or the change) framed.
      const bodyOf = (x: Entry, rowKey: string, indent: number) => {
        const isDiff = opened.has(`diff:${rowKey}`) && x.prevText !== undefined
        const lines = x.text.split('\n')
        const shown = lines.slice(0, MAX_SHOWN_LINES).join('\n')
        const diff = isDiff ? unifiedDiff(x.prevText ?? '', x.text) : undefined
        return (
          <Box flexDirection="column" paddingLeft={indent + 3} marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Button key={`copy:${rowKey}`} dimColor onPress={press => void $.ui.copy({ text: x.text, surface: press.surface })}>
                Copy
              </Button>
              {x.prevText !== undefined && (
                <Button key={`diffbtn:${rowKey}`} dimColor onPress={toggle(`diff:${rowKey}`)}>
                  {isDiff ? 'Show text' : `Changes since ${clock(x.prevAt ?? x.at)}`}
                </Button>
              )}
            </Box>
            {isDiff ? (
              diff === undefined ? (
                <Text size="footnote" dimColor>
                  Too long to diff here; both versions are in the debug log.
                </Text>
              ) : Code ? (
                <Code source={diff} format="diff" />
              ) : (
                <Text>{diff}</Text>
              )
            ) : Code ? (
              <Code source={shown.replace(/[^\t\n\P{Cc}]/gu, '')} language="markdown" />
            ) : (
              <Text>{shown}</Text>
            )}
            {!isDiff && lines.length > MAX_SHOWN_LINES && (
              <Text size="footnote" dimColor>
                … {lines.length - MAX_SHOWN_LINES} more lines (copy it, or see the debug log)
              </Text>
            )}
            {lines.length > FOOTER_AFTER_LINES && (
              <Button key={`end:${rowKey}`} dimColor onPress={toggle(rowKey)}>
                ▴ Collapse {x.label}
              </Button>
            )}
          </Box>
        )
      }

      const notesOf = (x: Entry) => [
        ...(x.by ?? []),
        ...(x.gone ? [x.gone] : []),
        ...(x.prevText !== undefined ? [`changed ${clock(x.at)}`] : []),
      ]

      const row = (x: Entry, rowKey: string, indent: number, how: { label?: string; mono?: boolean; seen?: boolean }) => (
        <Box key={rowKey} flexDirection="column" paddingLeft={indent}>
          {headLine({
            rowKey,
            size: x.text.length,
            label: how.label ?? x.label,
            mono: how.mono,
            gone: x.gone !== undefined,
            meta: [
              tokens(x.text.length),
              how.seen && x.count > 1 ? `×${x.count}` : '',
              how.seen ? span(x.at, x.lastAt) : '',
              tidy(x.meta),
            ]
              .filter(Boolean)
              .join(' · '),
            notes: notesOf(x),
          })}
          {opened.has(rowKey) && bodyOf(x, rowKey, indent)}
        </Box>
      )

      const body = () => {
        if (current === 'turns') {
          const shownTurns = turnList.slice(-SHOWN_TURNS)
          const early = inTurn(0)
          if (shownTurns.length === 0 && early.length === 0) return <Text dimColor>No turns yet.</Text>
          const groups: { n: number; label: string; at?: string; quote?: string; xs: Entry[] }[] = [
            ...(early.length > 0 ? [{ n: 0, label: 'Before the first turn', xs: early }] : []),
            ...shownTurns.map(t => ({
              n: t.n,
              label: `Turn ${t.n}`,
              at: t.at,
              quote: t.text ? `“${t.text}”` : undefined,
              xs: inTurn(t.n),
            })),
          ]
          return groups.map(g => {
            const key = `turn:${g.n}`
            return (
              <Box key={key} flexDirection="column">
                {headLine({
                  rowKey: key,
                  size: chars(g.xs),
                  label: g.label,
                  quote: g.quote,
                  meta: [g.at ? clock(g.at) : '', `${g.xs.length} reminders`, tokens(chars(g.xs))].filter(Boolean).join(' · '),
                })}
                {opened.has(key) && g.xs.map(x => row(x, `${key}:${x.key}`, 3, {}))}
              </Box>
            )
          })
        }
        if (current === 'reminders') {
          if (kinds.length === 0) return <Text dimColor>Nothing yet.</Text>
          return kinds.map(({ label, xs }) => {
            if (xs.length === 1) return row(xs[0]!, xs[0]!.key, 0, { seen: true })
            const key = `kind:${label}`
            const newest = [...xs].sort((p, q) => q.lastAt.localeCompare(p.lastAt))
            const latest = newest[0]!
            const total = xs.reduce((n, x) => n + x.count, 0)
            const first = xs.reduce((m, x) => (x.at < m ? x.at : m), latest.at)
            return (
              <Box key={key} flexDirection="column">
                {headLine({
                  rowKey: key,
                  size: latest.text.length,
                  label,
                  meta: [tokens(latest.text.length), `×${total}`, `${xs.length} versions`, span(first, latest.lastAt)].join(' · '),
                  notes: [...new Set(xs.flatMap(notesOf))],
                })}
                {opened.has(key) &&
                  newest.map(x => row(x, `${key}:${x.key}`, 3, { label: peek(x.text), mono: true, seen: true }))}
              </Box>
            )
          })
        }
        const entries = byGroup[current]
        if (entries.length === 0) return <Text dimColor>Nothing yet.</Text>
        return entries.map(x => row(x, x.key, 0, {}))
      }

      const summary =
        current === 'turns'
          ? `${turnList.length} turns · turn ${lastTurn} carried ${tokens(chars(inTurn(lastTurn)))} of reminders`
          : current === 'reminders'
            ? `${kinds.length} kinds · ${byGroup.reminders.length} distinct texts · oldest first`
            : `${sent(byGroup[current]).length} sent · ${tokens(chars(byGroup[current]))}`
      const [model, ...rest] = (shownHeader || 'model not seen yet').split(' · ')

      return (
        <Box flexDirection="column">
          <Box flexDirection="column" marginBottom={1}>
            <Text size="heading" weight="semibold">
              {model}
            </Text>
            <Text size="footnote" dimColor>
              {[...rest, ...(shownTraits.length ? [shownTraits.join(', ')] : [])].join(' · ')}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {(Object.keys(TITLES) as Group[]).map(group => (
              <Button key={`tab:${group}`} variant={group === current ? 'primary' : undefined} onPress={pick(group)}>
                {`${TITLES[group]} ${counts[group]}`}
              </Button>
            ))}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1} marginBottom={1}>
            <Box flexGrow={1}>
              <Text size="footnote" dimColor>
                {summary}
              </Text>
            </Box>
            <Button key="collapse-all" dimColor onPress={collapseAll}>
              Collapse all
            </Button>
            <Button key="export" dimColor onPress={() => void exportSnapshot($)}>
              Export
            </Button>
          </Box>
          {body()}
        </Box>
      )
    }
  })
}
