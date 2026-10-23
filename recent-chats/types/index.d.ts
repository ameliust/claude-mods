/** Per chat: what this session was last told, so later updates add only what is new. */
export type SeenChat = { updatedAt: string; turns: number; summary: string }
export type Seen = Record<string, SeenChat>
