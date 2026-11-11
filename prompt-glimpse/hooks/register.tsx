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

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)
const now = () => new Date().toISOString()
const clock = (iso: string) => iso.slice(11, 19)
// A rough size: about four characters to a token for English prose and code.
const tokens = (chars: number) =>
  chars < 4000 ? `~${Math.max(1, Math.round(chars / 4))} tok` : `~${(chars / 4000).toFixed(1)}k tok`
const bar = (part: number, whole: number) => {
  const n = whole > 0 ? Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * 8)) : 0
  return '█'.repeat(n) + '·'.repeat(8 - n)
}

// ---- provenance: who changed what beneath us -------------------------------

type Item = { key: string; text: string }
type Layer = { plugin: string; items: Item[] }
type Provenance = { tags: Map<string, string[]>; removed: { key: string; text: string; by: string }[] }

// next.trace lists the links beneath a hook nearest first, the engine last;
// turned around, each layer is what one link handed up.
function layersOf<O>(
  trace: readonly { plugin: string; returned: O | undefined }[],
  items: (o: O) => Item[],
): Layer[] {
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
    meta: tokens(r.text.length),
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

// A line diff (longest common subsequence), cut to the changed lines and two
// lines of context around each.
type DiffLine = { sign: ' ' | '+' | '-' | '…'; line: string }

function lineDiff(before: string, after: string): DiffLine[] | undefined {
  const a = before.split('\n')
  const b = after.split('\n')
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
      all.push({ sign: ' ', line: a[i]! })
      i++
      j++
    } else if (j < b.length && (i === a.length || at(i, j + 1) >= at(i + 1, j))) {
      all.push({ sign: '+', line: b[j++]! })
    } else {
      all.push({ sign: '-', line: a[i++]! })
    }
  }
  const near = all.map((_, k) => all.slice(Math.max(0, k - 2), k + 3).some(x => x.sign !== ' '))
  const out: DiffLine[] = []
  all.forEach((x, k) => {
    if (near[k]) out.push(x)
    else if (out.length > 0 && out[out.length - 1]!.sign !== '…') out.push({ sign: '…', line: '' })
  })
  return out
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

async function writeLog($: EngineInterface, name: string, head: string, text: string) {
  if (!isLogging) return
  const dir = await dirs($)
  if (fileCount === undefined) {
    counting ??= countFiles($, dir)
    await counting
  }
  fileCount = (fileCount ?? 0) + 1
  const file = `${dir}/${String(fileCount).padStart(4, '0')}-${fileSafe(name)}.md`
  try {
    await $.fs.write(file, `${head}\n\n${text}\n`)
  } catch (err) {
    await $.ui.log(`prompt-glimpse: could not write ${file}: ${String(err)}`)
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
  const items = sections.map((s, i) => ({ key: s.id, text: s.text, meta: `${s.scope} · ${tokens(s.text.length)} · #${i + 1}` }))
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
  const items = blocks.map(b => ({ key: b.name, text: b.text, meta: tokens(b.text.length) }))
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
// dispatch. Writing each with its own update made them fight over the value
// until the engine gave up, so they queue here and one loop writes them all.
type Pending = { type: string; agentId?: string; origin: string; text: string; by: string[]; dropped?: string; at: string }

let pending: Pending[] = []
let flushing: Promise<void> | undefined

async function flushReminders($: EngineInterface) {
  while (pending.length > 0) {
    const batch = pending
    pending = []
    const known = await read($, turns)
    const turn = known.at(-1)?.n ?? 0
    let added: Pending[] = []
    await update($, reminders, list => {
      added = []
      const next = [...list]
      for (const p of batch) {
        const key = `reminder:${p.type}:${p.agentId ?? ''}:${p.dropped ?? ''}:${p.text}`
        const k = next.findIndex(x => x.key === key)
        if (k >= 0) {
          const x = next[k]!
          const seen = x.turns ?? []
          next[k] = {
            ...x,
            count: x.count + 1,
            lastAt: p.at,
            turns: seen[seen.length - 1] === turn ? seen : [...seen, turn].slice(-50),
          }
          continue
        }
        added.push(p)
        const where = p.agentId ? ` · agent ${p.agentId}` : ''
        next.push({
          key,
          label: p.type,
          meta: `${p.origin}${where} · ${tokens(p.text.length)}`,
          text: p.text,
          at: p.at,
          lastAt: p.at,
          count: 1,
          by: p.by.length > 0 ? p.by : undefined,
          gone: p.dropped,
          turns: [turn],
        })
      }
      return next.slice(-MAX_REMINDERS)
    })
    for (const p of added) {
      const where = p.agentId ? ` · agent ${p.agentId}` : ''
      const how = [...p.by, ...(p.dropped ? [p.dropped] : [])].join(', ')
      await writeLog(
        $,
        `reminder-${p.type}`,
        `# Reminder: ${p.type}\n\n${p.at} · turn ${turn} · ${p.origin}${where}${how ? ` · ${how}` : ''}`,
        p.text,
      )
    }
  }
}

async function queueReminder($: EngineInterface, p: Pending) {
  pending.push(p)
  flushing ??= flushReminders($).finally(() => {
    flushing = undefined
  })
  await flushing
}

let awaitingStart = false

async function startTurn($: EngineInterface, text: string) {
  try {
    const at = now()
    await update($, turns, list => {
      const n = (list.at(-1)?.n ?? 0) + 1
      const turn: Turn = { n, at, text: text.replace(/\s+/g, ' ').slice(0, 80) }
      return [...list, turn].slice(-MAX_TURNS)
    })
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
    const { Box, Text, Button } = $.ui.resolve(e)
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
    const counts: Record<Group, string> = {
      system: tokens(chars(byGroup.system)),
      context: tokens(chars(byGroup.context)),
      reminders: String(byGroup.reminders.length),
      turns: String(turnList.length),
    }

    // One row: a header button that opens it, and when open its text (or its
    // diff), a copy button and a closing button at the end of a long one.
    const row = (x: Entry, rowKey: string, largest: number, indent: number, showTurns: boolean) => {
      const isOpen = opened.has(rowKey)
      const isDiff = opened.has(`diff:${rowKey}`)
      const lines = x.text.split('\n')
      const shown = lines.slice(0, MAX_SHOWN_LINES).join('\n')
      const seen = showTurns
        ? x.count > 1
          ? ` · ×${x.count}, ${clock(x.at)}–${clock(x.lastAt)}`
          : ` · ${clock(x.at)}`
        : ''
      const notes = [...(x.by ?? []), ...(x.gone ? [x.gone] : []), ...(x.prevText !== undefined ? [`changed ${clock(x.at)}`] : [])]
      const diff = isDiff && x.prevText !== undefined ? lineDiff(x.prevText, x.text) : undefined
      return (
        <Box key={rowKey} flexDirection="column" paddingLeft={indent}>
          <Button key={`row:${rowKey}`} onPress={toggle(rowKey)}>
            {isOpen ? '▾' : '▸'} <Text dimColor>{bar(x.gone ? 0 : x.text.length, largest)}</Text>{' '}
            <Text strikethrough={x.gone !== undefined}>{x.label}</Text>{' '}
            <Text dimColor>
              {x.meta}
              {seen}
            </Text>
            {notes.length > 0 && <Text color="warning"> · {notes.join(' · ')}</Text>}
          </Button>
          {isOpen && (
            <Box paddingLeft={2} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button key={`copy:${rowKey}`} onPress={press => void $.ui.copy({ text: x.text, surface: press.surface })}>
                  copy
                </Button>
                {x.prevText !== undefined && (
                  <Button key={`diffbtn:${rowKey}`} onPress={toggle(`diff:${rowKey}`)}>
                    {isDiff ? 'show text' : `show change since ${clock(x.prevAt ?? x.at)}`}
                  </Button>
                )}
              </Box>
              {isDiff && x.prevText !== undefined ? (
                diff === undefined ? (
                  <Text dimColor>too long to diff here; both versions are in the debug log</Text>
                ) : (
                  <Box flexDirection="column">
                    {diff.map((d, k) => (
                      <Text
                        key={`d${k}`}
                        color={d.sign === '+' ? 'success' : d.sign === '-' ? 'error' : undefined}
                        dimColor={d.sign === ' ' || d.sign === '…'}
                      >
                        {d.sign === '…' ? '  …' : `${d.sign} ${d.line}`}
                      </Text>
                    ))}
                  </Box>
                )
              ) : (
                <Text>{shown}</Text>
              )}
              {!isDiff && lines.length > MAX_SHOWN_LINES && (
                <Text dimColor>… {lines.length - MAX_SHOWN_LINES} more lines (copy it, or see the debug log)</Text>
              )}
              {lines.length > FOOTER_AFTER_LINES && (
                <Button key={`end:${rowKey}`} onPress={toggle(rowKey)}>
                  ▴ collapse {x.label}
                </Button>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const body = () => {
      if (current === 'turns') {
        const shownTurns = turnList.slice(-SHOWN_TURNS)
        const early = inTurn(0)
        if (shownTurns.length === 0 && early.length === 0) return <Text dimColor>no turns yet</Text>
        const groups: { n: number; label: string; xs: Entry[] }[] = [
          ...(early.length > 0 ? [{ n: 0, label: 'before the first numbered turn', xs: early }] : []),
          ...shownTurns.map(t => ({ n: t.n, label: `${clock(t.at)} ${t.text ? `“${t.text}”` : '(no typed prompt)'}`, xs: inTurn(t.n) })),
        ]
        return groups.map(g => {
          const key = `turn:${g.n}`
          const isOpen = opened.has(key)
          const size = chars(g.xs)
          const largest = Math.max(1, ...g.xs.map(x => x.text.length))
          return (
            <Box key={key} flexDirection="column">
              <Button key={`row:${key}`} onPress={toggle(key)}>
                {isOpen ? '▾' : '▸'} turn {g.n} <Text dimColor>· {g.label} · {g.xs.length} reminders · {tokens(size)}</Text>
              </Button>
              {isOpen && g.xs.map(x => row(x, `${key}:${x.key}`, largest, 2, false))}
            </Box>
          )
        })
      }
      const entries = byGroup[current]
      if (entries.length === 0) return <Text dimColor>nothing yet</Text>
      const largest = Math.max(1, ...entries.map(x => x.text.length))
      return entries.map(x => row(x, x.key, largest, 0, current === 'reminders'))
    }

    const summary =
      current === 'turns'
        ? `${turnList.length} turns on the main loop; turn ${lastTurn}'s reminders ${tokens(chars(inTurn(lastTurn)))}`
        : `${sent(byGroup[current]).length} sent, ${tokens(chars(byGroup[current]))}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {(Object.keys(TITLES) as Group[]).map(group => (
            <Button key={`tab:${group}`} variant={group === current ? 'primary' : undefined} onPress={pick(group)}>
              {TITLES[group]} {counts[group]}
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="collapse-all" onPress={collapseAll}>
            Collapse all
          </Button>
          <Button key="export" onPress={() => void exportSnapshot($)}>
            Export snapshot
          </Button>
        </Box>
        <Text dimColor>
          {TITLES[current]}: {summary} · {shownHeader || 'model not seen yet'} · traits{' '}
          {shownTraits.length ? shownTraits.join(', ') : '(none yet)'}
        </Text>
        {body()}
      </Box>
    )
  })
}
