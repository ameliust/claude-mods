export type Group = 'system' | 'context' | 'reminders' | 'turns'

// One thing Claude was sent: a system prompt section, a context block, or an
// injected attachment (what the model reads inside a <system-reminder>).
// Reminders with the same type and text collapse into one entry with a count.
export type Entry = {
  key: string
  label: string
  meta: string
  text: string
  at: string
  lastAt: string
  count: number
  // Which plugins beneath prompt-glimpse changed it on the way out, read from
  // next.trace: "edited by cc-redacted", "added by x". Empty when untouched.
  by?: string[]
  // Set on a row that is no longer sent: who removed it, or "dropped since".
  gone?: string
  // The text it had before its latest change (only with showDiff on).
  prevText?: string
  prevAt?: string
  // Main-loop turn numbers this reminder was injected in (latest 50).
  turns?: number[]
}

export type Turn = { n: number; at: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-glimpse': {
      system: Entry[]
      context: Entry[]
      reminders: Entry[]
      turns: Turn[]
      traits: string[]
      header: string
      open: string[]
      tab: Group
    }
  }
}
