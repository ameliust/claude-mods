# claude-mods

Mods (hook-module plugins) for Claude, written with Claude.

## recent-chats

Gives Claude an ambient sense of your other recently active conversations. On each message you type, it checks which of your other chats moved in the last 12 hours. The first time a session sees a chat, a small model (Haiku) writes one line about it in the background: title, the shape of the conversation, and where it stands now. That line arrives with your next message. Later, when the chat moves again, it summarizes only the new turns, as a short `update:` line, so earlier lines are never rewritten. The lines are labelled as context, not instruction.

Notes:
- Project chats are not seen; the past-chat tools only cover chats outside projects.
- Attaching context per message does not invalidate earlier thinking blocks.
- State is kept in the plugin store; a compaction resets it so the next line is a full summary.

Status: early prototype.

## prompt-glimpse

A read-only window onto what Claude is actually sent. A pane groups it four ways: the system prompt section by section (each section's id, cache scope and size, from `prompt.compose`), the context blocks the first message carries (`prompt.context`), every system reminder or other injected attachment (`prompt.attachment`, the text inside the `<system-reminder>` wrapper), and the reminders grouped by the turn that carried them. Tabs at the top switch groups, and every row starts collapsed: press its ▸ to expand it, copy it, or close it again from its end. Text is shown in a framed code view, and a change as a real diff. Sizes are estimated tokens (about four characters each), with a five-step bar on a fixed log scale (1, 20, 100, 500, 2.5k tokens), so it reads the same in every tab. The Reminders tab shows one row per reminder type, with how often it was sent; a type whose text changes, like the token countdown, opens into its versions, newest first. The header shows the model, the number of tools and the prompt's traits, such as `lean` or `bare`. `/prompt-glimpse` reopens the pane.

Each row also says which plugin changed it on its way out, for example `edited by cc-redacted`. Rows another plugin removed stay in the list, struck through, as `removed by …`. The mod reads this from the hook chain beneath it, so it sees only plugins loaded inside it. Load prompt-glimpse first (with `--plugin-dir`, the first folder named is the outermost) to see every change.

With the `showDiff` option on (off by default), each section and context block keeps the text it had before its latest change. A changed row then offers "show change since …", a line diff. Rows that stopped being sent stay listed as `not sent since …`.

**Export** writes the whole effective prompt to one Markdown file in the log folder: every section, context block, the latest turn's reminders and a list of every distinct reminder.

With the `debugLog` option on (off by default), each new system prompt version, each context block set and each reminder is also written as its own numbered Markdown file under `~/.claude/prompt-glimpse-logs/<session id>/`. Numbering continues across reloads. The `logDir` option changes the folder. The files hold everything Claude is sent, your CLAUDE.md and context blocks included, and nothing deletes them.

The pane's data lives in the session's memory: it survives a reload of the mod and is gone when the session ends. Only the log and the snapshots are written to disk.

The mod never changes what is sent: every hook passes the engine's answer through untouched.

Status: early prototype.

## cc-redacted

Takes identifying details out of what Claude is sent, for experiment runs (pilots, evals) that need a clean, sensitive-detail-free context. It changes only the text Claude reads; the tools, the working directory and everything else still behave as usual. Each part is an option:

- `dropContext` lists first-message context blocks to leave out (default `userEmail,claudeMd,attachedProject,currentDate`).
- `dropSections` lists system prompt sections to leave out by id (default `env_info,env_info_simple,memory`; the memory section names your home folder). Add `total_tokens` to drop the token-budget line from the prompt.
- `dropReminders` lists injected reminder types to leave out (default `environment,model,date,remote_session_change`). `date` is the engine's own copy of today's date, and `remote_session_change` is the commit attribution, which names the model. Add `total_tokens_reminder` to drop the token countdown.
- `scrub` takes literal `find=>replace` pairs separated by `|`, applied to everything still sent, tool descriptions included.
- `autoScrub` (on by default) also replaces the home folder with `~`, the account user name with `user` and the email with `user@example.com`.
- `auditFile`, when set to an absolute path, lists every drop and replacement, never the original text.

What it cannot hide: the tools themselves say which platform you are on (a PowerShell tool exists only on Windows, and the Bash tool says it runs Git Bash). Run the experiment from a neutral folder, since the working directory is still the real one for the tools.

For a print run, load it from its folder and pass options through `--settings`. `--setting-sources project,local` leaves out your user settings, so your installed plugins, personal skills and hooks stay out; `--strict-mcp-config` leaves out MCP servers and claude.ai connectors:

```
claude -p --setting-sources project,local --strict-mcp-config --plugin-dir ./cc-redacted --settings '{"pluginConfigs":{"cc-redacted":{"options":{"auditFile":"/abs/path/audit.txt"}}}}' "your prompt"
```

Load `prompt-glimpse` beside it to check the result. Name prompt-glimpse's folder first (`--plugin-dir ./prompt-glimpse --plugin-dir ./cc-redacted`): it then shows what is really sent, with each removal tagged `removed by cc-redacted`. Named second, it sits beneath cc-redacted and shows the text before redaction.

Status: early prototype.

## Install

```
/plugin install recent-chats --marketplace ameliust/claude-mods
/plugin install prompt-glimpse --marketplace ameliust/claude-mods
/plugin install cc-redacted --marketplace ameliust/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.
