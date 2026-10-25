import type { EngineInterface, Register } from 'claude-code'

// What this does: takes identifying details out of what Claude is sent, for
// experiment runs that need a clean context. Each part is one option:
//   dropContext   -> context blocks left out of the first message (prompt.context)
//   dropSections  -> system prompt sections left out by id (prompt.compose)
//   dropReminders -> injected messages left out by type (prompt.attachment)
//   scrub         -> literal find=>replace pairs applied to whatever is still
//                    sent, tool descriptions included (tool.describe)
//   autoScrub     -> also replaces the home folder, user name and email
// With auditFile set, every drop and replacement is listed in that file.
// The engine sends today's date again as a `date` reminder, and the commit
// attribution (which names the model) as `remote_session_change`; both are in
// the default dropReminders.

type Pair = { find: string; replace: string; pattern: RegExp }

const names = (v: unknown) =>
  typeof v === 'string' ? new Set(v.split(',').map(s => s.trim()).filter(Boolean)) : new Set<string>()
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// Module state; built from options at load, auto pairs filled on first use.
let userPairs: Pair[] = []
let autoPairs: Pair[] | undefined
let isAuto = true
let auditFile = ''
const audit: string[] = []
const audited = new Set<string>()

function pair(find: string, replace: string, wordOnly = false): Pair {
  const body = escape(find)
  return { find, replace, pattern: new RegExp(wordOnly ? `\\b${body}\\b` : body, 'gi') }
}

function parseScrub(v: unknown): Pair[] {
  if (typeof v !== 'string') return []
  return v
    .split('|')
    .map(p => p.split('=>'))
    .filter((p): p is [string, string] => p.length === 2 && p[0]!.trim() !== '')
    .map(([find, replace]) => pair(find.trim(), replace.trim()))
}

async function ensureAuto($: EngineInterface): Promise<Pair[]> {
  if (autoPairs) return autoPairs
  const found: Pair[] = []
  if (isAuto) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const user = (await $.env.get('USERNAME')) ?? (await $.env.get('USER'))
    if (home) {
      found.push(pair(home, '~'))
      found.push(pair(home.replace(/\\/g, '/'), '~'))
      // The memory folder names projects by path with separators as dashes.
      found.push(pair(home.replace(/[:\\/]/g, '-'), '~'))
    }
    if (user && user.length >= 3) found.push(pair(user, 'user', true))
  }
  autoPairs = found
  return found
}

async function note($: EngineInterface, line: string) {
  if (audited.has(line)) return
  audited.add(line)
  audit.push(`${new Date().toISOString()} ${line}`)
  if (auditFile === '') return
  try {
    await $.fs.write(auditFile, audit.join('\n') + '\n')
  } catch (err) {
    await $.ui.log(`cc-redacted: could not write ${auditFile}: ${String(err)}`)
  }
}

async function scrub($: EngineInterface, where: string, text: string): Promise<string> {
  const all = [...userPairs, ...(await ensureAuto($))].sort((a, b) => b.find.length - a.find.length)
  let out = text
  for (const p of all) {
    let hits = 0
    out = out.replace(p.pattern, () => {
      hits += 1
      return p.replace
    })
    // The audit names what replaced it, never the original text.
    if (hits) await note($, `replaced ${hits}x in ${where}: ${p.find.length} chars -> "${p.replace}"`)
  }
  return out
}

export const register: Register = (on, options) => {
  const dropContext = names(options.dropContext)
  const dropSections = names(options.dropSections)
  const dropReminders = names(options.dropReminders)
  userPairs = parseScrub(options.scrub)
  isAuto = options.autoScrub !== false
  auditFile = typeof options.auditFile === 'string' ? options.auditFile : ''
  autoPairs = undefined

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const blocks = []
    for (const b of result.blocks) {
      // Learn the email before the block goes, so other text can be scrubbed of it.
      if (b.name === 'userEmail' && isAuto) {
        const email = EMAIL.exec(b.text)?.[0]
        if (email && !userPairs.some(p => p.find === email)) userPairs.push(pair(email, 'user@example.com'))
      }
      if (dropContext.has(b.name)) {
        await note($, `dropped context block ${b.name} (${b.text.length} chars)`)
        continue
      }
      blocks.push({ ...b, text: await scrub($, `context ${b.name}`, b.text) })
    }
    return { ...result, blocks }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = []
    for (const s of result.sections) {
      if (dropSections.has(s.id)) {
        if (!e.traits.includes('analysis')) await note($, `dropped section ${s.id} (${s.text.length} chars)`)
        continue
      }
      sections.push({ ...s, text: await scrub($, `section ${s.id}`, s.text) })
    }
    return { ...result, sections }
  })

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    if (dropReminders.has(e.type)) {
      if (result.text !== null) await note($, `dropped reminder ${e.type}`)
      return { ...result, text: null }
    }
    if (result.text === null) return result
    return { ...result, text: await scrub($, `reminder ${e.type}`, result.text) }
  })

  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    return { ...result, description: await scrub($, `tool ${e.tool}`, result.description) }
  })
}
