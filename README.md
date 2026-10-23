# claude-mods

Mods (hook-module plugins) for Claude, written with Claude.

## recent-chats

Gives Claude an ambient sense of your other recently active conversations. On each message you type, it checks which of your other chats moved in the last 12 hours. The first time a session sees a chat, a small model (Haiku) writes one line about it in the background: title, the shape of the conversation, and where it stands now. That line arrives with your next message. Later, when the chat moves again, it summarizes only the new turns, as a short `update:` line, so earlier lines are never rewritten. The lines are labelled as context, not instruction.

Notes:
- Project chats are not seen; the past-chat tools only cover chats outside projects.
- Attaching context per message does not invalidate earlier thinking blocks.
- State is kept in the plugin store; a compaction resets it so the next line is a full summary.

Status: early prototype.

## Install

```
/plugin install recent-chats --marketplace ameliust/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.
