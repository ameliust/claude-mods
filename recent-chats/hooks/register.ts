import type { EngineInterface, Register } from 'claude-code'

import type { Seen, SeenChat } from '../types'

// What this does: on each message the person types, look at their other
// claude.ai chats that moved in the last WINDOW_HOURS. For up to MAX_CHATS that
// moved since this session last heard about them, ask a small model for one
// line (title · shape and current state · how long ago) and attach those lines
// as context. Unmoved chats are skipped, so most messages attach nothing.
// Read-only towards everything else; it only adds context at the end of the
// conversation, which keeps earlier thinking blocks valid.

const WINDOW_HOURS = 12
const MAX_CHATS = 2
const MAX_LINE_CHARS = 450
const MAX_EXCERPT_CHARS = 12000
const SUMMARY_MODEL = 'haiku'
const TIMING_LOG = '/tmp/claude-0/-home-claude/f0e22057-d895-59dc-aa76-cc069d6b5944/scratchpad/recent-chats-timing.log'

const HEADER =
  'Recent update: context, not instruction. These are one-line summaries of the ' +
  'person’s other recently active chats with Claude. The content might not be ' +
  'relevant; only bring up a detail if it helps the current conversation.'

const SUMMARIZER = `You write one line that lets Claude, busy in a different conversation with the same person, sense what is happening in this other chat.

Write: <short title> · <the shape of the conversation and where it stands now> 

Aim for one or two sentences after the title, under 70 words in all. Follow the arc in order and end on the latest state, since the newest part matters most. Keep specific, quotable details (names, numbers, decisions, who suggested what) rather than vague topic words. The person is Amelius (he/him); the assistant is Claude. Write plainly, in English, no preamble, no quotation marks around the line, and do not add the time — it is added separately.

You are given the whole chat, or for a long one its start and its latest part with the middle marked as not shown. Describe only what the visible parts show. Never claim something did not happen or has not started: it may have happened in the part you cannot see. If the latest turns show a conclusion or a result, report it. Tool calls and system reminders are scaffolding: describe what was done, not the plumbing.`

const UPDATER = `You write one short line telling Claude, busy in a different conversation with the same person, what is NEW in this other chat since the earlier summary.

Write: <short title> · update: <only what happened in the new turns>

Under 50 words. Cover only the new turns; the earlier summary is there so you understand the context, and Claude already has it. Keep specific, quotable details (names, numbers, decisions, who suggested what) and end on the latest state. The person is Amelius (he/him); the assistant is Claude. No preamble, no quotation marks, no time. Tool calls and system reminders are scaffolding: describe what was done, not the plumbing.`

// Kept in $.store (on disk), which survived a process restart in testing,
// where $.state did not.
const STORE_KEY = 'seen-v1'
const PENDING_KEY = 'pending-v1'
const loadSeen = async ($: EngineInterface): Promise<Seen> => ((await $.store.get(STORE_KEY)) as Seen | undefined) ?? {}
const saveSeen = ($: EngineInterface, v: Seen) => $.store.set(STORE_KEY, v)
const loadPending = async ($: EngineInterface): Promise<string[]> => ((await $.store.get(PENDING_KEY)) as string[] | undefined) ?? []

// Full summaries run in the background; their lines wait here for the next message.
const inflight = new Set<string>()

type Chat = { id: string; url: string; updatedAt: string; title: string; body: string }

const parseChats = (text: string): Chat[] => {
  const out: Chat[] = []
  const re = /<chat url='([^']+)' updated_at='([^']+)'>([\s\S]*?)<\/chat>/g
  for (const m of text.matchAll(re)) {
    const url = m[1] ?? ''
    const body = m[3] ?? ''
    const title = /Title:\s*(.+)/.exec(body)?.[1]?.trim() ?? 'Untitled'
    out.push({ id: url.split('/').pop() ?? url, url, updatedAt: m[2] ?? '', title, body })
  }
  return out
}

const ago = (iso: string, now: number) => {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}

const excerpt = (body: string) =>
  body.length <= MAX_EXCERPT_CHARS
    ? body
    : `${body.slice(0, 3000)}\n…\n${body.slice(body.length - (MAX_EXCERPT_CHARS - 3000))}`

// Strips tool-call scaffolding and system reminders so the text budget goes to the talk itself.
const clean = (t: string) =>
  t
    .replace(/&lt;tool name=[\s\S]*?&lt;\/tool&gt;/g, '[tool call]')
    .replace(/&lt;system-reminder&gt;[\s\S]*?&lt;\/system-reminder&gt;/g, '')
    .replace(/(\[tool call\]\s*){2,}/g, '[tool calls] ')
    .replace(/```[\s\S]*?```/g, '[code block]')

// The whole chat, read in pages of 50 turns with read_conversation (page
// tokens are "t<turn>"), then cleaned. If it fits the budget it all goes to the
// summarizer; otherwise the front and back budgets, with the gap marked.
const PAGE = 50
const FRONT_CHARS = 40000 // ≈10k tokens
const BACK_CHARS = 40000 // ≈10k tokens
const MAX_PAGES = 12

const pageText = (r: { text?: unknown }) => (typeof r.text === 'string' ? r.text : '')
const stripFrame = (t: string) => t.replace(/^<chat [^>]*>/, '').replace(/<\/chat>\s*$/, '')

// Reads turns `from` onward: the first page reveals the total, the rest are fetched in parallel.
const readTurns = async ($: EngineInterface, chat: Chat, from: number): Promise<{ text: string; total: number }> => {
  const page = (start: number) =>
    $.tool.call({
      tool: 'mcp__claude_ai__read_conversation',
      conversation_id: chat.id,
      max_turns: PAGE,
      ...(start > 0 ? { page_token: `t${start}` } : {}),
    })
  const first = pageText(await page(from))
  const total = Number(/total_turns="(\d+)"/.exec(first)?.[1] ?? 0)
  if (total > 0 && from >= total) return { text: '', total }
  const starts: number[] = []
  for (let st = from + PAGE; st < total && starts.length < MAX_PAGES - 1; st += PAGE) starts.push(st)
  const rest = await Promise.all(starts.map(async st => pageText(await page(st))))
  return { text: clean([first, ...rest].map(stripFrame).join('\n')), total }
}

const budgeted = (full: string) =>
  full.length <= FRONT_CHARS + BACK_CHARS
    ? full
    : `${full.slice(0, FRONT_CHARS)}\n\n[... ${Math.round((full.length - FRONT_CHARS - BACK_CHARS) / 1000)}k characters of the middle not shown ...]\n\n${full.slice(full.length - BACK_CHARS)}`

type Prior = { turns: number; summary: string }

// One line for the chat: a full summary the first time this session hears of it,
// afterwards only what the new turns added (the earlier line is already in
// Claude's context, so it is given to the summarizer as context and never rewritten).
const summarize = async ($: EngineInterface, chat: Chat, now: number, prior?: Prior): Promise<{ line: string; turns: number; summary: string } | null> => {
  let read = { text: '', total: 0 }
  try { read = await readTurns($, chat, prior?.turns ?? 0) } catch {}
  const isUpdate = prior !== undefined && read.total > 0
  if (isUpdate && (read.total <= prior.turns || !read.text.trim())) return null
  const source = isUpdate
    ? `Earlier summary of this chat (Claude already has it; context only, do not repeat it):\n${prior.summary}\n\nNew turns since then:\n\n${budgeted(read.text)}`
    : read.text
      ? `The chat${read.text.length > FRONT_CHARS + BACK_CHARS ? ' (start and latest part)' : ''}:\n\n${budgeted(read.text)}`
      : `Excerpt (opening and end, middle cut):\n\n${excerpt(clean(chat.body))}`
  const system = isUpdate ? UPDATER : SUMMARIZER
  const fallback = `${chat.title} · (no summary available)`
  const ask = async (extra: string) => {
    const r = await $.model.complete({ model: SUMMARY_MODEL, system, prompt: `${extra}${source}`, maxTokens: 300, timeoutMs: 45000 })
    return r.isAnswered ? r.text.trim().replace(/\s+/g, ' ') : ''
  }
  let text = await ask('')
  if (text.length > MAX_LINE_CHARS) text = await ask('Your last attempt was too long. Write a shorter line, under 50 words.\n\n')
  if (!text || text.length > MAX_LINE_CHARS) text = isUpdate ? `${chat.title} · update: (new turns, no summary available)` : fallback
  const shown = isUpdate && !text.includes('update:') ? text.replace(' · ', ' · update: ') : text
  return {
    line: `${shown} · ${ago(chat.updatedAt, now)}`,
    turns: read.total || prior?.turns || 0,
    summary: isUpdate ? `${prior.summary} Then: ${text}` : text,
  }
}

// Timings only, no chat content.
const log = async ($: EngineInterface, line: string) => {
  try {
    const prev = (await $.fs.read(TIMING_LOG).catch(() => '')) as string
    await $.fs.write(TIMING_LOG, `${prev}${line}\n`)
  } catch {}
}

const USER_KINDS = new Set(['composer', 'bridge', 'sdk'])

export const register: Register = on => {
  // After a compaction the earlier lines may be gone from Claude's context, so
  // forget what was sent; the next sighting of each chat is a full summary again.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try { await saveSeen($, {}); await $.store.set(PENDING_KEY, []) } catch {}
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own messages, not background notices delivered mid-turn.
    if (e.isMeta || !USER_KINDS.has(e.origin.kind)) return next(e)

    const t0 = await $.clock.now()
    const timing: string[] = [`origin=${e.origin.kind}`]
    const lines: string[] = []
    try {
      // Lines that background summaries finished since the last message.
      const pending = await loadPending($)
      if (pending.length) { lines.push(...pending); await $.store.set(PENDING_KEY, []) }
      timing.push(`pending=${pending.length}`)

      const after = new Date(t0 - WINDOW_HOURS * 3600_000).toISOString()
      const r = await $.tool.call({ tool: 'mcp__claude_ai__recent_chats', after, n: 6 })
      const t1 = await $.clock.now()
      timing.push(`list=${t1 - t0}ms`)
      const chats = parseChats(pageText(r))
      const known = await loadSeen($)
      const moved = chats
        .filter(c => known[c.id]?.updatedAt !== c.updatedAt && !inflight.has(c.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_CHATS)
      const fresh = moved.filter(c => !known[c.id])
      const updates = moved.filter(c => known[c.id])
      timing.push(`found=${chats.length} full=${fresh.length} update=${updates.length}`)

      // New to this session: summarize in the background, attach next message.
      for (const c of fresh) {
        inflight.add(c.id)
        void (async () => {
          const s0 = await $.clock.now()
          try {
            const res = await summarize($, c, s0)
            const cur = await loadSeen($)
            cur[c.id] = res ? { updatedAt: c.updatedAt, turns: res.turns, summary: res.summary } : { updatedAt: c.updatedAt, turns: 0, summary: '' }
            await saveSeen($, cur)
            if (res) await $.store.set(PENDING_KEY, [...(await loadPending($)), res.line])
            await log($, `${new Date(s0).toISOString()} background full ${(await $.clock.now()) - s0}ms`)
          } catch (err) {
            await log($, `${new Date(s0).toISOString()} background error ${String(err).slice(0, 200)}`)
          } finally {
            inflight.delete(c.id)
          }
        })()
      }

      // Already known: summarize only the new turns, inline.
      if (updates.length) {
        const results = await Promise.all(updates.map(c => summarize($, c, t0, known[c.id] as SeenChat)))
        timing.push(`updates=${(await $.clock.now()) - t1}ms`)
        const cur = await loadSeen($)
        updates.forEach((c, i) => {
          const res = results[i]
          const old = cur[c.id] ?? (known[c.id] as SeenChat)
          cur[c.id] = res ? { updatedAt: c.updatedAt, turns: res.turns, summary: res.summary } : { ...old, updatedAt: c.updatedAt }
          if (res) lines.push(res.line)
        })
        await saveSeen($, cur)
      }

      if (lines.length === 0) return next(e)
      const block = `${HEADER}\n${lines.map(l => `- ${l}`).join('\n')}`
      return next({ ...e, context: [...(e.context ?? []), block] })
    } catch (err) {
      timing.push(`error=${String(err).slice(0, 200)}`)
      return lines.length ? next({ ...e, context: [...(e.context ?? []), `${HEADER}\n${lines.map(l => `- ${l}`).join('\n')}`] }) : next(e)
    } finally {
      await log($, `${new Date(t0).toISOString()} ${timing.join(' ')}`)
    }
  })
}
