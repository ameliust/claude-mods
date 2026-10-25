# claude-mods

Mods (hook-module plugins) for Claude, written with Claude.

## recent-chats

Gives Claude an ambient sense of your other recently active conversations. On each message you type, it checks which of your other chats moved in the last 12 hours. The first time a session sees a chat, a small model (Haiku) writes one line about it in the background: title, the shape of the conversation, and where it stands now. That line arrives with your next message. Later, when the chat moves again, it summarizes only the new turns, as a short `update:` line, so earlier lines are never rewritten. The lines are labelled as context, not instruction.

Notes:
- Project chats are not seen; the past-chat tools only cover chats outside projects.
- Attaching context per message does not invalidate earlier thinking blocks.
- State is kept in the plugin store; a compaction resets it so the next line is a full summary.

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

Status: early prototype.

## Install

```
/plugin install recent-chats --marketplace ameliust/claude-mods
/plugin install cc-redacted --marketplace ameliust/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.
