# Bots plugin — Host ⇄ Client contract

All routes live under `/__dsh_bots/`. GET returns JSON; state-changing calls are
`POST` with `content-type: application/json` and return `{ ok: true, ... }` or
`{ ok: false, reason }`.

## Data shapes

```ts
type Avatar =
  | { kind: 'emoji'; emoji: string; color: string }        // color: CSS colour, e.g. '#7c5cff'
  | { kind: 'image'; url: string; color: string };         // url = /__dsh_bots/avatar/<botId>?v=<n>

type Skill = { id: string; name: string; description: string; content: string; enabled: boolean };

type App = {
  id: string;
  template: 'open-computer-use' | 'mcp-stdio' | 'mcp-http';
  name: string;                 // display name
  serverName: string;           // [A-Za-z0-9_-]{1,32}, tools appear as mcp__<serverName>__*
  enabled: boolean;
  config: { command?: string; args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string> };
};

type Bot = {
  id: string;                   // 'bot-xxxx'
  name: string;                 // display name, any language
  handle: string;               // lowercase [a-z0-9-], unique; used as @handle in DMs
  role: 'primary' | 'bot';      // exactly one primary (the dispatcher)
  avatar: Avatar;
  bio: string;                  // one line shown on cards
  persona: string;              // system-prompt persona prose
  skills: Skill[];
  apps: App[];
  tools: { deny: string[] };    // DSH global tools this bot may NOT use
  model: { provider: string; model: string } | null;   // null = DSH default
  sessionId: string | null;     // the bot's home conversation (DSH session)
  createdAt: number; updatedAt: number;
  createdBy: 'user' | string;   // 'user' or creating bot id
  status?: 'idle' | 'running' | 'offline';   // live, from the agent registry
};

type Message = { id: string; from: string; to: string; text: string; at: number; kind: 'dm' | 'user' | 'system' };
  // from/to: bot id, or 'user'
```

## Routes

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `state` | – | `{ bots: Bot[], primaryId, sessionMap: {[sessionId]: botId}, messageCount, version, limits: { skills: 200, skillsOn: 50 } }` |
| GET | `catalog` | – | `{ templates: AppTemplate[], tools: {name, description}[], models: {provider, model, label}[], skills: {name, description}[], ocu: {installed: boolean, path} }` |
| POST | `save` | `{ bot: Partial<Bot> }` (no id = create) | `{ ok, bot }` |
| POST | `delete` | `{ id }` | `{ ok }` (primary cannot be deleted) |
| POST | `primary` | `{ id }` | `{ ok }` make this bot the dispatcher |
| POST | `open` | `{ id }` | `{ ok, sessionId }` ensure the bot's home session exists |
| POST | `send` | `{ to, text }` | `{ ok, sessionId }` the user DMs a bot (delivered as a user prompt to its session) |
| GET | `messages` | `?bot=<id>&limit=200` (bot optional = all) | `{ items: Message[] }` oldest first |
| POST | `avatar` | `{ id, dataUrl }` (PNG/JPEG/WebP/GIF ≤ 2 MB) | `{ ok, bot }` |
| GET | `avatar/<id>` | – | the image bytes |
| GET | `schedules` | `?bot=<id>` | `{ items: Task[] }` (Task = DSH schedule entry: id, title, prompt, kind, scheduledAt, status, lastDelivery, timing fields) |
| POST | `schedules/save` | `{ botId, id?, title, prompt, timing }` timing = DSH Schedule timing, e.g. `{kind:'daily', daily:{time:'09:00:00', time_zone:'Asia/Singapore'}}`, `{kind:'every', every_seconds:3600}`, `{kind:'weekly', weekly:{time, time_zone, weekdays:[1..7]}}`, `{kind:'cron', cron:{expression, time_zone}}`, `{kind:'at', at:'ISO'}` | `{ ok, task }` |
| POST | `schedules/delete` | `{ id }` | `{ ok }` |
| POST | `schedules/toggle` | `{ id, active }` | `{ ok }` |
| POST | `schedules/run` | `{ id }` | `{ ok }` |

`AppTemplate = { id, name, description, transport: 'stdio'|'streamable-http', defaults: App['config'], serverName }`.

## v0.2 changes

### Avatars
`Avatar = { kind: 'initials', text?: string /* ≤2 chars override */, color } | { kind: 'image', url, color, source?: 'ai' }`.
Emoji avatars are gone: old `{kind:'emoji'}` rows normalize to initials. With no `text`, the client
derives the letters from the name: first letters of the first two words ("Data Scout" → DS, "Atlas" → AT,
"DataBot" → DB), or pinyin initials of the first two Han characters ("研究员" → YJ, via
`Intl.Collator('zh-Hans-u-co-pinyin')` against the bounds `阿八嚓哒妸发旮哈丌咔垃妈拏噢妑七呥仨他屲夕丫帀` /
letters `ABCDEFGHJKLMNOPQRSTWXYZ`; the Host has the same `initialsOf` in lib/store.mjs).

| POST | `avatar/generate` | `{ id, style? }` | `{ ok, bot }` draws a picture with the Images plugin (`generate_image`); takes 10–90 s |
| POST | `avatar/clear` | `{ id }` | `{ ok, bot }` back to initials |

`catalog.imageGen: boolean` — whether `generate_image` is available.

The tools manage avatars too (0.8): `bot_update` and `bot_create` take `avatar_prompt` (a picture drawn by the
Images plugin from that description; without the plugin the result says so at once and the rest of the change still
applies) and `avatar_file` (an absolute path to a PNG, JPEG, WebP or GIF of at most 2 MB); `bot_update` also takes
`avatar_clear: true` (back to initials). Called from a bot's home or task Session (or a helper of one), a drawing runs
in the background: the call returns at once, and when the drawing ends that conversation gets one note, steered
(an idle home starts a turn; several notes arriving together are one step), with the message id `bots:avatar:<job>`
and source `{ kind: 'agent-message', form: 'relay' }`: `[Avatar ready] The new avatar of @x (Name) is ready…`,
`[Avatar failed] The picture for @x could not be drawn: <reason>. Its avatar is unchanged.`, or `[Avatar dropped] …`
when another conversation or the panel changed that avatar meanwhile. A home's turn takes the note like a report: the
chats of the turn that asked are its Threads, so the answer to the person goes there. A task Session gets it like any
message for its task (not after the task ended). Only the latest drawing asked for a bot counts: a newer one, a
picture file, `avatar_clear`, new letters or colour, a panel upload or clear replaces it (one replaced from the same
conversation sends nothing). Drawings are kept in memory only: a restart drops them without a note. From a
conversation of no bot, and through `avatar/generate`, the call waits for the picture as before; while any drawing
runs, `state.bots[].avatarPending` is `true`.

### Apps
`App = { id, template, name, serverName, enabled, values: {[fieldKey]: string}, config: {command?, args?, env?, url?, headers?} }`.
Catalog apps keep their settings in `values` (keys from the template's `fields`); custom apps
(`mcp-stdio`, `mcp-http`) keep using `config`.

`catalog.templates: AppEntry[]`, `catalog.categories: {id, en, zh}[]`.
```ts
AppEntry = { id, name: {en, zh}, description: {en, zh}, category, icon /* 1–3 letters or a CJK char */, color,
  transport: 'stdio'|'streamable-http', serverName, command?, args?, url?, runtime?: 'node'|'uv'|'binary',
  homepage, keyUrl?, region?: 'cn', featured?: boolean, custom?: boolean, fields?: AppField[] }
AppField = { key, label: {en, zh}, kind: 'secret'|'text'|'path', required?, placeholder?, default?, multi? /* one per line */, help?: {en, zh} }
```
`state.bots[].appIssues: {[appId]: string}` — why an app cannot start (e.g. a required key is empty).

## v0.3 changes — built for one-person companies and bot teams

### Teams (start here)
| GET | `teams` | – | `TeamView[]` |
| POST | `teams/hire` | `{ id, lang: 'zh'|'en' }` | `{ ok, team, bots: Bot[], dispatcherId, kickoff: string, skipped: {bot, kind:'skill'|'app'|'schedule', name, reason?}[] }` (can take 10–30 s: imports skills from GitHub). `bots`: the members, after the dispatcher when the hire made one (there was none) |

```ts
TeamView = { id, name:{en,zh}, tagline:{en,zh}, description:{en,zh}, color, kickoff:{en,zh},
  desk: {when, title:{en,zh}}[],   // scheduled tasks the hire gives the dispatcher
  bots: { key, handle, name:{en,zh}, color, bio:{en,zh},
          skills: {name, source:'dsh'|'import', repo?, available}[], apps: {id, available}[], tasks: {when, title:{en,zh}}[] }[] }
```
Teams: `opc` 一人公司, `dev` 研发小队, `content` 内容工作室, `research` 研究台. `bot.team` holds the team id.
A team has no lead (0.11.1): its members join the one dispatcher, made (Atlas) when there is none, which gets the
team's `desk` tasks unless it has one by that title. After hiring, the client should offer to send `kickoff` to the
dispatcher (POST send {to: dispatcherId, text: kickoff}). `state.oldLeads` (`{id, name, handle, team}[]`) lists leads
hired before 0.11.1 that are not the dispatcher, until `lead-notice/dismiss`.

### Skills
`Skill = { id, name, source: 'own'|'dsh'|'import', description, content, enabled, dir?, origin? }`
- `dsh`: an installed Harness skill referenced by name (content not stored; it stays up to date).
- `import`: copied from GitHub with its files; `origin` is the GitHub URL.
- `own`: written by hand or by the bot itself.

| GET | `skills/library` | – | `{ skills: {name, description, source}[] /* installed Harness skills, ~90 here */, sources: SKILL_SOURCES }` |
| POST | `skills/github` | `{ repo }` (owner/repo[/path] or github URL) | `{ ok, owner, repo, ref, skills: {name, description, path, files}[] }` |
| POST | `skills/import` | `{ botId, items: [{repo, ref?, path} | {url} | {local}] }` | `{ ok, bot, added: string[], updated: string[] /* same name, same origin: replaced in place */, off: string[] /* added switched off: `skillsOn` already on */, skipped: {name, reason: 'exists'\|'full' /* `skills` kept */}[], failed }` |
| GET | `skills/local` | – | `{ places: {path, label, magpie?: true}[] /* skill folders of other agents found on this machine, Magpie's library first */ }` |
| GET | `skills/magpie` | – | (0.17.2) `{ ok, root, skills: {name, description, path, files, agents: string[] /* Magpie's agent ids it gives the skill to, from its library.json */}[], truncated }`, or `{ ok: false, reason }` with no library. Imported as `{local: path}`; a folder inside the library is stored with `from: 'magpie'` |
| POST | `skills/local` | `{ path }` (a skill folder or a folder of them; `~` allowed) | `{ ok, root, skills: {name, description, path, files}[], truncated }`; a `{local: path}` import links the folder (`linked: true`, `dir` = the folder), nothing is copied |
| POST | `skills/write` | `{ botId, text }` | `{ ok, sessionId }` — asks the bot to write the skill itself (via skill-creator) and save it |
Adding Harness skills: POST save with skills + `{name, source:'dsh', enabled:true}`.
`catalog.skillSources = [{id:'anthropics', repo:'anthropics/skills', path:'skills', name, description}]`.
`catalog.magpie = { root } | null` (0.17.2): Magpie's skill library, `<its files>/library/skills`, looked for in
`~/.config/magpie` (where its app keeps its files) and then `$XDG_CONFIG_HOME/magpie` (its command line's).

### Abilities (DSH built-ins, replaces the raw tool checklist as the primary control)
`catalog.abilities = [{ id, name:{en,zh}, description:{en,zh}, tools: string[], available: string[], risky? }]`
ids: web, files, code, office, images, delegate, schedule, ask, deliver, plugins. An ability is OFF when
all its `available` tools are in `bot.tools.deny`. Toggling writes the deny list (keep unrelated denies).
Keep the raw tool list as an "Advanced" disclosure.

### Apps
Catalog reorganised by business use (`categories`: business 销售与收款, work 团队与办公, dev 研发与交付,
research 调研与内容, computer, data, life, custom). Removed what DSH already does (filesystem, fetch, time,
excel, sequential-thinking, chrome-devtools). New: stripe, hubspot, feishu (飞书), supabase.
| GET | `apps/external` | – | `{ items: {from, name, serverName, template, config /* values masked */}[] }` MCP servers found in Codex / Claude Code / Claude Desktop / Cursor / Windsurf / Gemini / opencode configs |
| POST | `apps/import` | `{ botId, names: ['<from>/<name>'] }` | `{ ok, bot, added }` |

## Chat channels (Telegram, Discord, Feishu / Lark, Slack)

People message the team from a chat app; replies go back to the chat. A channel is an ordinary app on a
bot whose catalog entry has `kind: 'channel'`; it is **not** an MCP server (`mcpConfigFor` returns `null`,
no MCP client starts for it, and editing it never restarts the bot's MCP clients).

```ts
AppEntry += { kind?: 'channel', channel?: 'telegram' | 'discord' | 'feishu' | 'slack', logo?: string }
  // channel entries have no transport/command; `logo` names logos/<logo>.png, served at GET /__dsh_bots/logo/<logo>.png
// Catalog (category 'work'):
//   telegram     #229ED9  fields: token (secret)
//   discord      #5865F2  fields: token (secret)
//   feishu-chat  #3370ff  channel 'feishu', fields: appId (text), appSecret (secret)   // Feishu or Lark, found by App ID
//   slack-chat   #4a154b  channel 'slack', fields: token (bot, xoxb-), appToken (app-level, xapp-; both secret)
App.values[secret field]   // in `state` and every route that returns a bot, a stored secret reads as '••••••••' (SECRET_MASK);
                           // POST save with the mask keeps the stored value, any other value replaces it.

state.bots[].channels: { [appId]: ChannelView }
ChannelView = {
  kind: 'telegram' | 'discord' | 'feishu' | 'slack',
  state: 'connecting' | 'connected' | 'error' | 'off' /* app disabled */ | 'missing' /* a required field is empty */,
  detail?: string,              // connector's words (never the token); with error/connecting
  hint?: string,                // the panel words these itself: token, intent, conflict, duplicate;
                                // Slack: app_token, app_scope, token_kind, scopes, socket_mode;
                                // Feishu: secret, appId, disabled, bot, scopes, connlimit
  fatal?: true,                 // will not retry until the token changes or `channels/reconnect`
  account: { username, name } | null,     // the chat bot it is connected as
  paired: { id, name, at, direct: boolean }[],   // paired[0] gets scheduled reports
  code: { code: string, expiresAt: number } | null,   // one-time pairing code, 10 minutes
  link: string | null,          // Telegram deep link t.me/<bot>?start=<code>; Slack: the app's DM; Feishu / Lark: a chat with the bot
  invite: string | null,        // Discord: OAuth2 invite URL for the bot
  scheduleReplies: boolean,     // scheduled runs report to paired[0] (default true)
  ignored: { count, lastName?, lastAt? },   // messages from unpaired people since the Host started
}

Message += { via?: 'telegram' | 'discord' | 'feishu' | 'slack', who?: string }
  // kind 'user' + via: typed in that chat app by `who` (text is the message without the source line);
  // kind 'reply' + via: this reply was also sent to that chat.
```

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `channels/code` | `{ botId, appId }` | `{ ok, code, expiresAt }` a new pairing code (the old one stops working) |
| POST | `channels/unpair` | `{ botId, appId, userId }` | `{ ok }` |
| POST | `channels/options` | `{ botId, appId, scheduleReplies: boolean }` | `{ ok, scheduleReplies }` |
| POST | `channels/reconnect` | `{ botId, appId }` | `{ ok }` drop and reconnect (after fixing a setting in the chat app's console) |

A connector is `lib/channels/<kind>.mjs` (transport only; `lib/channels.mjs` does pairing, routing and reply
targets). It exports `createConnector({ token, values, onMessage, onStatus, log })` returning
`{ start() → {id, username, name}, stop(), send(chatId, text, {replyTo}?), typing(chatId) }`, and may export
`TEXT_LIMIT`, `MARKDOWN` (the app renders Markdown replies), `THREADS` (every part of a reply goes to the
thread of `replyTo`) and `links({account, code, values})` → `{link?, invite?}`. Messages it reports:
`{chatId, userId, userName, text, isDirect, mentioned, messageId, order?, chatTitle?, source?, context?}`, where `order`
is a decimal string rising within a chat (the replay guard), `source` overrides the label in the
`[Feishu · Name]` line the bot reads (`Lark` for a Lark app), and `context` (Bots 0.16.2, Feishu) is the chat
context the connector read with the message: `{kind: 'root' | 'topic' | 'quoted' | 'forwarded', who, text}[]`,
oldest first within a kind. The hub renders it (`contextText`) as one block, `[Chat context, read from Feishu
with this message]`, which the bot reads right after the message (home, discussion and a follow-up to a task
alike), and which the turn's origin carries as `context`, beside `said` (the message's own words) and
`messageId`. Feishu reads, for a message addressed to the bot: the message it replies to (`quoted`; in a topic
the parent is its first message, a `topic` item), the first message of its reply chain (`root`) or the ten
latest earlier messages of its topic (`topic`, `GET /im/v1/messages?container_id_type=thread`), and for a
`merge_forward` in a DM (its `text` is `[Forwarded chat history]`, `forwarded: true`) up to 30 messages it holds;
the hub also puts a forward's context on the origin (not the delivery) of the next message in that Thread within
10 minutes that has none, so a task opened from "summarize this" keeps the history.
Each item is ≤ 800 characters (the quoted one ≤ 2000), ≤ 8000 in all, newest kept; files and images read as
`[file: name]`, `[image]`. It waits at most 6 s; a missing permission (`im:message:readonly`,
`im:message.group_msg`) is logged once and that lookup rests for 30 minutes.

Images (Feishu): a message may carry `images` (what the connector needs to fetch them; Feishu's image keys, at
most 10), and such a connector has `readImages(msg)` → `Promise<{mediaType, data: Uint8Array}[]>`, which never
throws and leaves out what it could not read. In a Feishu `image` message, or a `post` with `img` elements, each
image reads as `[image]` where it was (an image alone is the message `[image]`); images of the quoted message, a
topic or a forward stay `[image]` in `context`. The hub calls `readImages` only after pairing, the group check (an
@-mention or a reply to the bot) and the replay guard, so a stranger's image is never fetched, and passes what came
as `images` to `deliver` and `toTickets` beside `context`. Feishu reads each one from
`GET /im/v1/messages/{message_id}/resources/{image_key}?type=image` (permission `im:message:readonly`), all at once,
each within 20 s and 20 MB, typed by its bytes (PNG, JPEG, WebP, GIF); one that fails, is too big or is another
format is logged and left out, a missing permission is logged once and images rest for 30 minutes. The host stores
each through the attachment store, as an uploaded image (see v0.17 Images); one it refuses is left out. The text
keeps its `[image]` either way.

Behaviour (lib/channels.mjs):
- A connector runs per enabled channel app with a token; it is started, restarted (token change) and stopped
  (disabled, removed, bot deleted, plugin disposed) from the roster. One token runs in one place; a second app
  with the same token shows `hint: 'duplicate'`.
- Only paired people are heard. Pairing: a private chat, the current code (`CODE` or Telegram `/start CODE`);
  5 wrong codes per person or 20 per code lock pairing until a new code. Strangers get at most one
  "this bot is private" line per private chat per day; groups stay silent. In groups the bot only hears
  messages that mention it or reply to it.
- A paired person's message becomes a user prompt (`source.kind: 'user'`) in the owning bot's conversation, or
  in `@handle`'s when it starts with a roster handle, as two text blocks: `[Telegram · Name]` (plus the group
  name in a group) and the text. A typing indicator runs while the bot works (every 5 s). Since 0.8 the header
  names the Thread and a follow-up may go to a task instead: see "Thread keys" under v0.8.
- Replies (0.7; since 0.8 they follow each turn's Threads, see "Thread keys" under v0.8): a conversation whose
  latest user message came from a chat sends its user-facing replies
  (`kind: 'reply'` in the timeline) to that chat — including the dispatcher's report after teammates answer
  by DM. A user message from anywhere else (the panel) brings replies back to the panel. A scheduled run of
  the owning bot reports to `paired[0]` privately when `scheduleReplies`. Telegram gets plain text
  (Markdown markers removed), Discord the Markdown; both are split at the app's limit (4096 / 2000).
- A message id at or below the highest one handled in that chat is ignored (kept in `channels.json`), so a
  chat app handing a message out again after a restart never runs a task twice.

Connector contract (`lib/channels/<kind>.mjs`, transport only — Feishu or Slack inbound would be more of these):
```js
export const kind = 'telegram';      // 'discord'
export const TEXT_LIMIT = 4096;      // discord: 2000
export function createConnector({ token, onMessage, onStatus?, fetchImpl?, WebSocketImpl?, apiBase?, log? }) → {
  start(): Promise<{ id, username, name }>,   // resolves once authenticated; rejects on a bad token
  stop(): Promise<void>,                      // idempotent; nothing reconnects afterwards
  send(chatId, text, { replyTo }?): Promise<void>,   // splits at TEXT_LIMIT
  typing(chatId): Promise<void>,
  readImages?(msg): Promise<{ mediaType, data: Uint8Array }[]>,  // a message's `images` (Feishu); never throws
}
// onMessage({ chatId, messageId, userId, userName, text, isDirect, mentioned, chatTitle?, images? })
// onStatus({ state: 'connecting'|'connected'|'error'|'stopped', detail?, fatal? }) — never the token
```
Telegram reads `BOTS_TELEGRAM_API` (default https://api.telegram.org) so a local stand-in of the Bot API can be
used for testing.

## v0.7 — models, topics, memory, usage

### Models
`Bot.model = { provider, model, reasoningEffort? } | null` — `reasoningEffort` is one of the model's efforts.
`catalog.models[] += { group /* provider display name */, name, source?: 'custom'|'login', efforts?: {id, name}[], defaultEffort?, context? /* tokens */ }`,
`catalog.defaultModel = { provider, model } | null` (the Harness default).

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `models/sources` | – | `{ custom: Endpoint[], logins: Login[], apis: string[], writable }` |
| POST | `models/custom/test` | `{ api, baseURL, key?, route? }` (no key + route = the stored key) | `{ ok, models: {id, name?}[] }` |
| POST | `models/custom/save` | `{ route?, name, api, baseURL, key?, models: (string \| {id, contextWindow?})[] }` | `{ ok, route }` |
| POST | `models/custom/delete` | `{ route }` | `{ ok }` (bots on it go back to `model: null`) |
| POST | `models/login/connect` | `{ id: 'codex' }` | `{ ok, route: 'openai-codex' }` |
| POST | `models/login/disconnect` | `{ id: 'codex' }` | `{ ok }` |

```ts
Endpoint = { route /* 'bots-<slug>' */, name, api: 'openai-completions'|'openai-responses'|'anthropic-messages'|'google-generative-ai', baseURL, models: {id, name?, contextWindow?}[], keyConfigured: boolean }
Login = { id: 'codex'|'claude-code'|'gemini-cli'|'copilot', name, product, found, supported, account?, plan?, connected?, sync?, reason?: 'terms'|'harness'|'signin' }
```
An endpoint is a route in Harness's `llm-pi-ai` settings (`providers.<route>`, `apiKeyEnv: BOTS_<SLUG>_API_KEY`),
its key set through the credential store. The Codex login is the grant record `llm-pi-ai/openai-codex`
(`{type:'oauth', access, refresh, expires, accountId}`) plus a `providers.openai-codex` route; while in use it is
compared with `~/.codex/auth.json` every 5 minutes and on every `credentials/record-updated`, and the side holding
the older refresh token takes the other's tokens.

### Topics
`state.bots[].topic = { startedAt, lastActiveAt, tasks, context /* prompt tokens of the last call */ } | null`.
Message `kind: 'topic'` (`from: 'system'`, `text`: `'manual'|'idle'|'context'`) marks a new topic in the timeline.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `topic/new` | `{ id }` | `{ ok, sessionId }` (refused while the bot runs) |

`send` with `/new`, `/clear`, `/reset`, `/新话题` or `/新对话` first starts a new topic; text after the command goes
there. The same commands work from chat apps. A new topic = a new session for the bot; its schedules are
retargeted (`schedule.edit` patch `target`) before the old session is archived.

### Memory
```ts
Note = { id /* 'n-…' bot, 't-…' team */, text, kind: 'fact'|'preference'|'person'|'project'|'procedure'|'lesson', pinned?, source: 'auto'|'tool'|'user'|'dream', at, updated }
Journal = { id, at, bot, task, trigger, title, summary }
Digest = { date /* YYYY-MM-DD local */, text /* Markdown */, at }
```
| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `memory` | `?bot=<id>` | `{ scope, notes, journal /* newest first */, topic, topics /* past, newest first */, model, settings, tz }` |
| GET | `memory` | `?bot=team` | `{ scope: 'team', notes, digests, journal, dream: {lastDate, lastAt, result}, settings, tz }` |
| POST | `memory/put` | `{ scope: botId \| 'team', note: {id?, text?, kind?, pinned?} }` | `{ ok, note }` (no id = add) |
| POST | `memory/delete` | `{ scope, id }` | `{ ok }` |
| POST | `memory/dream` | `{}` | `{ ok, result: {bots: {bot, added, updated, removed}[], digest, team?, errors} }` |

`state.bots[].memoryNotes`, `state.teamNotes`: counts. Tools: `memory_save {text, scope?, kind?, replace_id?}`,
`memory_forget {id, scope?}`, `memory_search {query}`.

### Usage
| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `usage` | `?range=today\|7d\|30d\|90d\|all&bot=<id>&tz=<minutes east of UTC>` | `Report` |
| GET | `prices` | – | `{ overrides, list: {name, count, fetchedAt, loading, error}, models: {model, provider, price}[] }` |
| POST | `prices` | `{ model, price: {input, output, cacheRead?, cacheWrite?, currency: 'USD'\|'CNY'} \| null }` | `{ ok, …prices }` |
| POST | `prices/refresh` | `{}` | `{ ok, …prices }` |

```ts
Cost = { [currency]: number }
Totals = { tokens, input, output, cacheRead, cacheWrite, calls, cost: Cost, unpriced /* tokens */ }
Report = { range: {name, from, to, bucket /* ms */}, totals: Totals & {tasks, cacheRate}, prev: Totals & {tasks},
  series: {t, tokens, byBot: {[botId]: tokens}, cost}[], bots: ({bot, tasks} & Totals)[], models: ({provider, model, priced, priceSource} & Totals)[],
  kinds: ({kind: 'chat'|'compaction'|'memory'|'dream'} & Totals)[], schedules: {id, title, bot, runs, tokens, cost}[],
  tasks: TaskView[] /* running first, then newest */, topTasks: TaskView[], priceList }
TaskView = { id, bot, trigger: 'user'|'chat'|'schedule'|'dm', via?, from?, sched?, title, start, end, status: 'running'|'done'|'error'|'stopped', tokens, calls, cost }
```
`state.bots[].usageToday`: tokens today.

### Settings
| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `settings` | – | `{ settings }` |
| POST | `settings` | `{ patch: {topics?: {idleHours, maxContextK}, memory?: {auto, model, dream, dreamTime}} }` | `{ ok, settings }` |

`settings.display = { botMessages: 'line' | 'short' | 'full' }` (0.8; default `'line'`, anything else reads as
`'line'`): how a chat in the panel shows messages between bots (one line each; that and two lines of the text; the
whole message with a delegation's task card). `POST settings` takes it in `patch`; `state.display` carries it.

## v0.8 — tasks, the router, chat threads

A **task** is work one bot hands another, done in a Harness Session of its own (`ticket-<id>`). The code calls it a
*ticket*, and so do the route paths (`tickets/…`), the types below and the tool `bot_ticket`; the panel says task. A
**run** is what 0.7 called a task: everything one Session does from one request until it is idle again. The usage
files and `TaskView` keep the name `task` for runs.

### Settings
```ts
settings += {
  dispatcher: 'router',                // always 'router' since 0.11 (a stored 'hands-on' reads as 'router')
  tickets: {
    maxWorking: number,                // 4; 1–32. Task Sessions working at once; a person's message to a started task may take one more
    stallMinutes: number,              // 20; 1–1440. Quiet minutes before the status check, and again before the stall
    archiveHours: number,              // 24; 0–720. Hours after a task ended before its Session is archived (0: next upkeep)
  },
  routerNotice: null | 'pending' | 'dismissed',  // set once on the first start of 0.8: 'pending' when bots existed before
}
```
`POST settings` takes `tickets` in `patch` (0.11 drops `dispatcher` from a patch). Router mode is in effect when the
roster has at least two bots. A stored `dispatcher: 'hands-on'` reads as `'router'` with `routerNotice: 'pending'`.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `router-notice/dismiss` | `{}` | `{ ok: true, routerNoticePending: false }` |
| POST | `lead-notice/dismiss` | `{}` | `{ ok: true, oldLeads: [] }` (the panel removes the leads with `delete` first, or keeps them) |

### Bots and catalog
`Bot.tools = { deny: string[], routerAllow?: string[] }` — `routerAllow`: tools a router dispatcher keeps although
Router mode denies them. A save whose `tools` leaves `routerAllow` out keeps the stored list.

`catalog.routerDeny: string[]` — what Router mode denies the dispatcher's home by default: the `code` ability (`bash`,
`job_list`, `job_output`, `job_kill`, `load_workspace_dependencies`), `write`, `edit`, the `delegate` ability, the
`images` ability, the `office` ability, and `pwsh`, the terminals (`terminal_open`, `terminal_send`, `terminal_read`,
`terminal_signal`, `terminal_close`, `terminal_list`), `apply_patch` and `str_replace_editor`. A router home also gets a
`tools.guard` that refuses `bash` and `pwsh` running `sleep`, or in the foreground without a `timeoutMs` of at most
30 s (left out, it is Harness's 120 s; `run_in_background` passes), and `job_output` waits over 5 s (or without
`timeout_ms`). A task Session of the dispatcher is an ordinary worker: none of this applies there.

### State
```ts
state += {
  dispatcher: 'router',
  routerActive: boolean,               // router mode in effect now (the dispatcher has a teammate)
  routerNoticePending: boolean,
  attention: TicketRow[],              // tasks that need a person (stage question, failed or stalled), newest change first, ≤ 50
  ticketMap: { [sessionId]: ticketId },// unarchived task Sessions
}
state.sessionMap                       // also maps each unarchived task Session to its bot
state.bots[].tickets = { working, question, stalled, queued }   // counts of unarchived tasks
state += {
  at: number,                          // the Host's clock (ms), to time what runs
  taskActivity: { [ticketId]: Activity & { botId, title } },   // open tasks whose Session runs now
  display: { botMessages: 'line' | 'short' | 'full' },
}
state.bots[].activity?: Activity       // its home Session runs now
state.bots[].avatarPending?: true      // a picture is being drawn for it
```
`Activity` is what a Session does right now, while a turn runs: `{ kind: 'thinking' | 'tool' | 'writing', tool?, detail?,
startedAt, stepAt, steps }`. `tool` is the running tool's name; `detail` a summary of what it works on, ≤ 80
characters, only for tools the Host knows: a shell command's first line (`bash`, `pwsh`), a file's name (`read`,
`edit`, `write`), the search words (`web_search`, `…_search`, `grep`), a page's host and path (`web_fetch`), the
@handle work is handed to (`bot_send_message` with `to`; `#<id>` with `ticket`; none for a report), a skill's name.
Channel tokens and anything shaped or named like a key, token or password are replaced with `<redacted>`; tool
results are never read. `startedAt`: the turn's start; `stepAt`: the current activity's; `steps`: model calls so far
in the turn. The panel words it from `tool`, `detail` and its own dictionary.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `activity` | – | `{ ok, at, bots: { [botId]: { status, activity?, avatarPending? } }, taskActivity }`: the live part of `state`, cheap to poll; the panel polls it every 1.5 s while anything runs |

### Task data
`tickets.json` under the cache, written whole through a temp file (mode 0600):
```ts
{ version: 1, tickets: Ticket[], threads: Thread[] }

Ticket = {
  id: string,                          // 't' + 8 lowercase letters and digits
  title: string,                       // ≤ 120 characters; from the first line of `text` when not given
  text: string,                        // what was asked, ≤ 50 000 characters
  botId: string,                       // the bot doing it
  sessionId: string | null,            // 'ticket-<id>' once started
  requester: { kind: 'session' | 'user', sessionId?, botId?, ticketId? },  // ticketId: asked from that task (a sub-task)
  parentId?: string,
  origin: { threadKey?, via?, who?, replyTo?, said?, context?, ids? },  // via: 'telegram' | 'discord' | 'feishu' | 'slack' | 'schedule'
                                       // replyTo: id of the group message that asked; the answer there quotes it
                                       // said / context / ids (0.16.2): the chat message it was opened from (≤ 8000), the
                                       // chat context read with it (≤ 12 000) and {chat, message, root} ids; a sub-task
                                       // inherits them. Its first message shows them under "--- Where it came from ---"
                                       // (≤ 4000 characters; `said` left out when the assignment repeats it), and
                                       // `ticket/<id>/source` reads them whole
  threads: string[],                   // Thread keys it is subscribed to (its origin's, when it has one)
  reports: { at, status: 'progress' | 'done' | 'blocked' | 'question', text }[],  // newest 200, each ≤ 20 000 characters
  createdAt, updatedAt, startedAt?,
  lastEventAt?,                        // latest event in its Session
  lastHumanAt?, lastRequesterAt?,      // latest message from a person / from the requester
  nudgedAt?, stalledAt?, remindedAt?,  // watchdog
  retries: number,                     // "continue"s sent after temporary errors in a row
  parked?: { key, content, source, at, human? }[],  // messages for a started task waiting for a worker slot, oldest first
  error?: string,
  ended?: { at, by: 'worker' | 'requester' | 'user' | 'system', outcome: 'done' | 'stopped' | 'failed' },
  archivedAt?,
}

Thread = { key, kind, appKey, chatId, rootId?, label?, tickets: string[] /* subscribed task ids */, lastAt }
```
Only bots open tasks (`bot_send_message`), so `requester.kind` is `'session'`. The newest 500 archived tasks are kept;
Threads no task is subscribed to are dropped. A file that is not JSON in this shape is set aside as
`tickets.json.corrupt-<ms>` and tasks start empty; one that cannot be read (permissions, a directory in its place)
stops the plugin from starting, with a log line, so nothing writes over it.

A started task's Session gets a message only while the task holds a worker slot. A person's message (from the panel,
a chat follow-up, or a `bot_ticket` `retry` or `status` from a conversation of no bot) may take one slot over
`maxWorking`; any other (a bot's, the watchdog's) waits in `parked` while every slot is taken, and the task counts as
`queued` until the messages go in, oldest first, as a slot frees. Parked messages outlast a restart; the task ending
drops them.

Stage (`stageOf`, first match wins; "answered" means `lastHumanAt` or `lastRequesterAt` is later than that report):

| Stage | When | Panel |
|---|---|---|
| `failed` | `ended.outcome === 'failed'`, or open with an unanswered `blocked` report last | Failed |
| `question` | open with an unanswered `question` report last | Needs your answer |
| `stalled` | open and `stalledAt` set | Stuck |
| `queued` | open and never started (`startedAt` unset), or started with messages in `parked` | Queued |
| `working` | open otherwise | Working |
| `done` | `ended.outcome === 'done'` (a `done` report, or closed) | Done |
| `stopped` | `ended.outcome === 'stopped'` | Stopped |

```ts
TicketRow = { id, title, botId, stage, requester: { kind: 'bot', botId } | { kind: 'user' }, via?, createdAt, updatedAt,
  lastReport?: { status, preview /* ≤ 200 characters */ },
  activity?: Activity /* while its Session runs (see State) */ }
TicketView = TicketRow & {
  text, parentId?, children: string[], requesterSessionId: string | null, origin: { threadKey?, via?, who?, replyTo?, said?, context?, ids? },
  startedAt?, ended?, error?, archivedAt?, nudgedAt?, stalledAt?, retries? /* when not 0 */,
  reports: { at, status, text }[],
  threads: { key, kind, label }[],
  runs: { id, trigger, title, start, end, status, tokens, calls, cost }[],   // oldest first
  usage: { tokens, calls, cost },      // all calls made for the task, its memory summary included
  sessionId: string | null,
  running: boolean,                    // its Session is in a turn now
}
```

### Routes
| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `tickets` | `?bot=<id>&stage=<stage>[,<stage>…]&archived=0\|1&limit=50&offset=0` (limit 1–200) | `{ items: TicketRow[], next_offset: number \| null }`, latest change first |
| GET | `tickets/<id>` | – | `TicketView` |
| POST | `tickets/<id>/stop` | `{}` | `{ ok, …TicketView }` ends it as stopped by the user and cancels its running turn |
| POST | `tickets/<id>/close` | `{}` | `{ ok, …TicketView }` ends it as done and cancels its running turn |
| POST | `tickets/<id>/retry` | `{}` | `{ ok, …TicketView }` opens it again and hands the assignment over afresh (also one the user stopped) |
| POST | `tickets/<id>/message` | `{ text }` | `{ ok, …TicketView }` the user's message into its Session; an ended task opens again; a queued one gets it added to its assignment |
| GET | `threads/<key>` | key URI-encoded | `{ key, label, kind, tickets: TicketRow[], recent: { at, from, to, who?, text }[] }` (the last 10 timeline messages of that Thread, text ≤ 300 characters) |

An unknown id answers `{ ok: false, reason: 'no such task' }`; an archived task cannot be retried or messaged. A
task's requester hears of a stop or close by the user through an injected note that does not wake it (on a Harness
without `inject`, it hears nothing). `delete` of a bot stops and archives its tasks, and stops every open task it asked
for (from its home or its tasks), which stays unarchived with `error: '@<handle>, who asked for it, was removed'`.

### Thread keys
`kind:appKey:chatId[:rootId]`, with `appKey` = `<botId>/<appId>` of the chat app; inside a part `%` and `:` are written
`%25` and `%3A`. A panel conversation is `panel:<sessionId>`. The root is the connector's `threadId`: Slack
`thread_ts` (a top-level channel message: its own `ts`), Discord the thread channel or the root of the reply chain,
Feishu the root message of the reply chain or topic, Telegram the forum topic (`message_thread_id`). Without one, a
Slack, Discord or Feishu group message is its own root (the bot answers under it); private chats and Telegram groups
without topics are the whole chat. Connectors report `threadId` on messages; `send` takes `{ threadId, replyTo }` and
`typing` takes `{ threadId }`.

A chat message reaches a bot as two text blocks, `[Telegram · Name] (thread <key>)` and the text; every block but the
last of a message the plugin delivers ends with a line break.

Inbound routing (`lib/threads.mjs` `routeInbound`):
1. A leading `@handle` of another bot goes to that bot's home; the channel owner's own handle goes to its home.
2. Tasks subscribed to the message's Thread that are not archived and not stopped take it, steered into each task
   Session as a person's message (an ended task opens again), and the owner's home gets a `[follow_up]` note injected
   without waking it. On a whole-chat Thread (no `rootId`) only a task whose latest report is an unanswered
   `question` takes it, and only when it is the one such task: with two or more, the message goes to the router (3).
3. Otherwise the owner's home (the router).

Plain replies (`createOrigins`): each turn of a home collects the Threads of its inputs (user messages, and the
origin Threads of the tasks a report, a `[Failed]` or `[Stalled]` note, or a `[Reminder]` is about). One chat Thread
and nothing else: the reply goes there. Only the panel, or nothing: it stays in the panel. Anything more, the panel
and one chat included: it stays in the panel (timeline entry `notSent: true`), and the bot sends each answer with
`bot_reply`. A task Session's text reaches no chat.

Deliveries the plugin makes with a key get the message id `bots:<key>`; one already pending, in the Session's stored
log or parked on its task is not delivered again. Router homes, task Sessions and relayed reports use `agent.steer`
(messages that arrive during a turn are taken together at its next step), notes that should not wake use
`agent.inject`, and other homes take user messages and 0.7 DMs with `followup` as before. A Harness without `steer`
gets `followup`; one without `inject` gets no such note (the `[follow_up]` note, a stop or close by the user): it is
dropped, never turned into a turn.

### Watchdog and restarts
The 5-minute upkeep (`lib/watchdog.mjs`):
- a `working` task whose Session is idle, with no shell jobs, sub-agents or working/queued sub-tasks, and no event,
  report or message for `stallMinutes`: one status check (`nudgedAt`); still nothing `stallMinutes` after it:
  `stalledAt`, a `[Stalled]` note to the requester, and its slot is freed;
- `agent/error` in a task Session: HTTP 408, 429 or 5xx, or a refused, reset or timed-out connection (not quota or
  billing errors), gets a "continue" after 15, 30 and 60 s (`retries`); then, or for any other error, the task ends as
  `failed` and the requester gets a `[Failed]` note. A completed turn resets `retries`;
- a requester Session that is idle, whose unarchived tasks have all settled (`done`, `failed`, `stopped`,
  `stalled`) and that said nothing since (a home: a timeline `reply` not marked `notSent`; a task Session: a report):
  one `[Reminder]` (`remindedAt`), at least a minute after the last one settled. A task Session whose task has ended
  gets none;
- tasks ended `archiveHours` ago: their Session is archived and `archivedAt` set.

At start, working tasks take their slots again. 3 s after the plugin starts, one whose Session had to be made anew
gets a `[Recovery]` note and its assignment; one whose stored log holds no message gets its assignment again; one whose
Session was mid-turn, or holds input it never took, gets the note. The note's id names the latest turn that did not end
cleanly, so a second restart before it is read sends nothing new, and a recovery turn cut off again gets a note of its
own. Then queued tasks start, and parked messages are handed over, while slots are free.

### Questions (`ask_user_question`)

Bots answers Harness's `user-questions/request` for a bot's home Session and for task Sessions, ahead of Harness's own
window: the request settles with whichever answers first, the panel or the conversation. With no window connected
(`NO_PROVIDER`) it waits for the panel. Questions with an `approval` or `plan-review` intent are recorded but only
answered in the conversation. A timed question that ran out stays answerable (`continued`) and is answered through
`userQuestions.answer`. Questions are kept in memory only.

- `GET /__dsh_bots/state` adds `asks: [{id, botId, sessionId, ticketId?, at, native?: true, continued?: true,
  questions: [{id, question, header?, detail?, options?: [{label, description?}], multiSelect?}]}]`, oldest first
  (`native` questions carry only `{id, question}`), and `bots[].asking`, the number waiting in that bot's home.
  `attention` also lists tasks whose Session waits on a question; task rows and views carry `asking: true` meanwhile.
- `POST /__dsh_bots/asks/:id/answer` with `{answers: [{id, selected: string[], custom?}]}` → `{ok: true}` or
  `{ok: false, reason}` (unknown or already answered, a `native` question, or an invalid answer: every question needs
  exactly one item, labels must be offered ones, a single choice takes one option or `custom`, and none may be empty).
- A panel answer is logged in the timeline as a user message, `"<question>\n→ <answer>"`, with `ticket` for a task.
- The watchdog skips a task that waits on a question. A chat the turn came from gets one notice per question.

### Tool approvals (`approval/request`, 0.17.2)

Harness's tool approvals (a write outside the workspace, a command outside the sandbox) do not go through
`user-questions/request`: the tools pipeline asks `ctx.approval.request({agent, toolName, callId?, reason?,
displayReason?, signal})`, whose answerers are `approval/request` waterfall listeners. Bots listens to it first
(`prepend`) for a bot's home Session and for task Sessions; other Sessions pass by untouched. The request settles with
whichever answers first, the window's card or the panel; the other is withdrawn (the forwarded request gets a signal
that aborts once the panel decided). An abort of the call settles it `cancelled`; a window that fails, `unavailable`.

- The approval is an entry of `state.asks` with `native: true` and `approval: {tool, callId?, display?: {[lang]: text}}`
  (`display` from `displayReason`); its one question is `{id: callId | 'approval', question}`, the question being
  `display.en`, else `reason`, else `Run the tool "<tool>"`. Task rows and views carry `asking: true` and
  `askingApproval: true` meanwhile.
- `POST /__dsh_bots/asks/:id/answer` with `{outcome: 'allowed-once' | 'rejected'}` decides it → `{ok: true}`, or
  `{ok: false, reason}` for any other body or one no longer waiting. Nothing is logged in the timeline.
- The bot that asked for the task hears what it waits for: `bot_ticket` `status` answers with it instead of sending a
  status request, `bot_send_message` adding to the task says so, and `bot_recall` cards carry
  `waiting_for: "the person's approval in its conversation: <question>"` (a question: `"the person's answer to its
  question: …"`).
- A chat the work came from gets one notice that the bot waits for approval, in the bot's language.

### Timeline
```ts
Message += { thread?: string, ticket?: string, status?: 'done' | 'blocked' | 'question' | 'stalled' | 'failed',
  added?: true, notSent?: true, choices?: string[] }
```
| kind | Fields | Entry |
|---|---|---|
| `dm` | `ticket` | a bot opened the task for `to` |
| `dm` | `ticket`, `added: true` | a message added to a task opened earlier (`from: 'user'`: the user, from the panel). The chat shows its own words marked as added; older entries have no `added`, so the chat also reads each later `dm` of a task as added |
| `dm` | `ticket`, `status: 'done' \| 'blocked' \| 'question'` | the task's report to its requester (`to`: the requesting bot); `progress` reports are not logged |
| `dm` | `ticket`, `status: 'stalled' \| 'failed'` | the watchdog marked the task stalled, or it failed after an error |
| `user` | `thread`, `via?`, `who?` | a message into a bot's home (`thread`: the chat Thread, or `panel:<sessionId>`) |
| `user` | `via`, `who`, `thread`, `ticket` | a chat follow-up that went straight to the task |
| `reply` | `thread`, `via?` | a bot's reply; `via` when it went to a chat (`bot_reply` too) |
| `reply` | `notSent: true`, `choices` | plain text of a turn with several chats: sent to none; `choices` are its chat Thread keys |
| `reply` | `error`, `thread`, `via?` | (0.16.1) a home or thread turn that answered a person's message, a report or a scheduled run ended in an error once Harness's retries were spent (not an empty answer, not a stop): a notice in the bot's language, sent where its answer would have gone (the turn's one Thread, or each of its chats). `error` is the error's message, secrets scrubbed. It does not count as telling the person (reminders still come) |

Entries written before 0.8 have none of these fields.

### Usage and memory
- `usage.jsonl` rows: `tk?` (the task; `t` stays the time). `tasks.jsonl` rows (runs): `t?` (the task).
- `TaskView += { ticket? }`.
- `Report += { tickets: ({ id, bot, title, runs } & Totals)[] }`: the window's calls by task, most tokens first, ≤ 60;
  `runs` counts the task's runs that ended in the window or are running.
- A task's runs are summarized into its bot's memory once, when the task ends: `Journal += { ticket? }`, with
  `trigger: 'ticket'`. A task Session is no topic: it never rotates, and its calls do not count toward the home's
  context.

### Tools
Every conversation gets `bot_reply`, `bot_recall` and `bot_ticket` besides the 0.7 tools. Since 0.10, in a team of more
than one bot the dispatcher's conversations (role `primary`: its home and any task of its own) are denied the
"Sub-agents & workflows" ability's tools (`subagent`, `wait_agent`, `workflow`, …; `GET catalog` lists them as
`teamDeny`, which the panel applies to the dispatcher only); the other bots keep them, and a router dispatcher's `bot_send_message` to
itself is refused (`you are the dispatcher: hand the work to a teammate, …`). A tool's `presentationMeta` leaves out
empty fields (0.9's `bot_reply` into the panel returned `via: undefined`, which Harness rejects as not lossless JSON:
the reply was shown, the call failed and the model sent the answer again). A Harness sub-agent or fork
(Session header `origin: 'subagent'` with a `parentSession`) uses the bot tools and the memory tools as the bot home or
task Session it descends from, with that one's limits; a helper of a conversation of no bot acts as no bot. One whose
line cannot be traced (a creator that is gone and was no bot's, or a loop) acts for no one: `bot_send_message`,
`bot_reply`, `bot_ticket`, `bot_create`, `bot_delete` and the memory tools refuse it (`bot_schedule` too, unless it
names `bot`), and `bot_recall` reads nothing.

`bot_send_message { to?, text, ticket?, status?, title?, thread?, report_to?, need? }`:

| Called from | Arguments | Does | Result |
|---|---|---|---|
| a task Session | no `to` (or the requesting bot, or `ticket` = its own id), `text`, `status` (required) | a report: `progress` is only recorded; `done`, `blocked`, `question` reach the requester at once; `done` ends the task. From a task that has ended, or a sub-task whose parent has ended, any report is only recorded (no relay, no timeline entry) | `{ ok, text, ticket: TicketRow, to, from }` |
| a task Session | `to`, `text`, `title?` | opens a sub-task (requester: this task) | `{ ok, text, ticket, stage, to, from }` |
| a bot's home | `to`, `text`, `title?`, `thread?`, `need?` (the router home only, 0.11) | opens a task; starts at once when a slot is free, else queued | `{ ok, text, ticket, stage, need?, to, from }` |
| the requester's Session, the requesting bot's current home, or the router home | `ticket`, `text`, `to?` (must be the task's bot) | adds a message to the task; an ended task opens again, except one the user stopped; with every slot taken it waits in `parked` | `{ ok, text, ticket, to, from }` |
| a conversation of no bot | `to`, `text` | into the other bot's home | `{ ok, text, to, from }` |

`title` defaults to the first line of `text`. `thread` names, when a turn has several chats, the Thread (one of the
turn's) a new task is for; left out then, the task belongs to none. A sub-task takes no Thread. `status` is refused
outside a report. New tasks and added messages count toward the 16 messages per pair of bots in 10 minutes. `to` and
`from` are bot faces (`{ id, name, handle, avatar, role }`).

`bot_reply { text, ticket?, thread? }` — one of `ticket` (the chat that task came from) or `thread` (a key, or
`thread/<key>`) is required. It resolves this turn's Threads first, then a stored Thread whose chat app is connected
and has someone paired. Only from a bot's home: refused in a task Session and in conversations of no bot. Result
`{ ok, text, thread, via? }`; a panel Thread only logs the reply.

`bot_recall { ref, offset? }`:

| ref | Result |
|---|---|
| `tickets` | `{ ref, items: Card[], total, next_offset? }`, open tasks first, then failed, then ended, archived last; newest first within each |
| `ticket/<id>` | `{ ref, card: Card, text /* ≤ 200 characters of the assignment */, chars?, more: string[] }` |
| `ticket/<id>/text`, `ticket/<id>/source`, `ticket/<id>/reports`, `ticket/<id>/transcript` | `{ ref, text, offset, chars, next_offset? }`: the assignment, the chat message it came from (the person's words, the chat context read with them, the chat app's ids), every report (newest first), the task Session's conversation |
| `thread/<key>` | `{ ref, thread: { key, kind, label, last_at }, items: Card[], total, next_offset?, recent?: { at, who, text }[] }` |
| `bot/<handle>` | `{ ref, bot: { handle, name, bio, dispatcher? }, items: Card[], total, next_offset? }` |

`task/…`, `tasks`, a bare task id and `@handle` work too. Lists come 20 to a page, text 4000 characters to a page;
pass `next_offset` as `offset`. `Card = { id, title, bot, stage, requester, parent?, children?, origin?: { thread?,
label?, via?, who? }, threads?, last_report?: { status, at, preview }, error?, archived?, updated_at }` (list items
leave out `children`, `threads` and `error`). From a task Session only that task, its parent, its sub-tasks and its
Threads can be read. `recent` comes from the timeline, whose entries carry a Thread from 0.8 on.

`bot_ticket { id, action: 'stop' | 'close' | 'retry' | 'status' }` — on a task this conversation asked for (the router
home and conversations of no bot: any task; a task Session: only its sub-tasks). `stop` ends it as stopped and
`close` as done, both cancelling its running turn; `retry` opens it again with the assignment (a bot cannot retry one
the user stopped); `status` asks an idle working task for a report. Result `{ ok, text, ticket: TicketRow }`.

`memory_search { query }` also matches tasks: every word in the title, else in one of its reports (most recently
changed first, ≤ 10). From a task Session only its task, parent and sub-tasks, and only their journal lines; no
digests. Result `+= { tickets: string[] }`.

## v0.9 — the panel chat in topics

0.10 replaces per-message topics with threads opened by a reply (see [v0.10](#v010--threads)); 0.9 data still reads as below.

### Topics
A message typed in the panel is a topic, or with `replyTo` joins the topic of the message it answers. A topic's key is
`panel:<sessionId>:<rootId>` (`rootId`: the id of its first message); the two-part `panel:<sessionId>` is still the
panel as a whole, and what was logged before 0.9 stays there (the main timeline). Messages typed in the panel get ids
`p` + 8 lowercase letters or digits; that id is how a model names a topic (`[Panel] (thread p…)`), and `bot_reply` /
`bot_send_message` take it for `thread`. Any message can become a topic's first message: one a person replies to that
was in no topic is given `topic` (its own id) and the three-part `thread`.

### Timeline
```ts
Message += {
  chat?: string,     // the bot whose panel chat it belongs to; set: only that chat shows it
  topic?: string,    // the root id of its panel topic; the root has topic === id
  replyTo?: string,  // the message a person replied to
  movedTo?: string,  // a top-level message the dispatcher filed under another topic: that topic's root id
  failed?: true,     // a panel message that could not be handed over
}
```
| kind | Fields | Entry |
|---|---|---|
| `user` | `chat`, `thread`, `topic`, `replyTo?`, `ticket?` | a panel message, logged before it is handed over; `ticket`: a reply that went straight to that task |
| `reply` | `chat`, `thread`, `topic?` | a bot's answer in a topic (a turn's only Thread, or `bot_reply`) |
| `reply` | `chat` (the bot that asked), `ticket`, `status`, `thread`, `topic?`, `via?` | a task's `done` / `question` / `blocked` report, shown to the person where the task came from (`from`: the task's bot) |
| `dm` | `chat`, `thread`, `topic`, `ticket` | a delegation, a message added to a task, a relayed report or a watchdog notice of a task that came from a panel topic |

`messages.jsonl` stays append-only: a change to a logged message is a later line `{ id, patch: true, ...fields }`,
merged into it when the log is read, and dropped when the log is compacted.

### Routes
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `messages` | `?bot=<id>&limit=200` | `{ items: Message[], topics: { [rootId]: { key, tickets: TicketRow[] } } }`, oldest first: messages whose `chat` is the bot, and those without `chat` from or to it. A reply in the window whose topic began earlier brings the topic's first message along, before the rest. `pending: true` on a panel message no model has taken yet (or waiting for a task to start or for a worker slot). `tickets`: the tasks subscribed to the topic, archived ones left out |
| GET | `messages` | `?bot=<id>&topic=<rootId>&limit=500` | the same shape for one topic: its first message, the replies in it and the messages filed under it |
| POST | `send` | `{ to, text, replyTo? }` | `{ ok, sessionId, message? }`: `message` is the logged message (with `topic`, the resolved root, and `pending`); none for `/new` alone. `replyTo` must be a message of that bot's chat |

### Routing
- A top-level panel message goes to the bot's home: a router home steers it with a header `[Panel] (thread <rootId>)`
  and `Open tasks: …` (its tasks still open or ended within a day, latest change first, ≤ 8); another home takes it as
  a turn of its own, with no header. Its delivery id is `bots:panel:<id>`, so it is logged once.
- A reply in a topic with live tasks (not archived, not stopped) goes to each of them as the person's message
  (`bots:panel:<id>:<ticketId>`, `[Panel]\nIn reply to …` when it answers a message other than the root), and the
  chat's bot gets an injected `[follow_up]` note. Without one it goes to the home, with `In reply to <who>: "…"`.
- One topic in a turn is a Thread like a chat thread: plain replies go into it. Several topics (or a topic and a
  chat) make a choice: `bot_reply` names each, and a new task must name its `thread` (refused otherwise, with the
  choices). Plain text of such a turn is not logged when `bot_reply` already answered every topic and chat of it.
- `bot_send_message { ticket }` from a home whose turn has one other panel topic that is only a person's message (or the
  one `thread` names) files that message under the task's topic (`movedTo`), and the turn's replies go there.

### Reports
`bot_send_message { …, report_to?: 'thread' | 'me' }` on a new task. A task with an origin Thread that is no sub-task
and was not opened with `report_to: 'me'` (`Ticket += { relay?: true }` for those) answers the person itself: its
`done`, `question` and `blocked` reports are logged as replies in its panel topic (or the panel), or posted to its chat
Thread through that chat's app (signed `【Name】` when the worker is not the bot the chat belongs to; quoting the
message that started it). The requester gets an injected note, id `bots:shown:<ticket>:<index>:<at>`, text
`[Shown] @bot's report on task …`, which is no input of its turn. When the chat cannot be reached the report goes to
the requester as in 0.8. Requester reminders skip these tasks. The worker's tool result says where it was shown.

### Router
`ROUTER_DENY` adds the web ability (`web_search`, `web_fetch`). The dispatcher's home may open a task for its own bot
(`to` its own handle); no other conversation can message itself.

## v0.10 — threads

The panel chat lists what was said in order, like a chat app. A reply to a message goes into that message's thread
and shows in the chat quoting what it answers. A thread on a task's own message goes to that task (as a 0.9 topic
with a live task did); any other thread is a **discussion**: the bot's conversation forked with Harness's
`sessionController.fork({ sessionId, atSeq })` at the replied message, so it sees that message and what came before,
and nothing the main chat said after it. The main conversation hears what was said in the threads with the person's
next message there (`[Threads]`, below).

### Timeline
Fields as in 0.9, with these meanings:

| Field | 0.10 |
|---|---|
| `topic` | only on a message inside a thread: the thread's root id. A message without `topic`, or with `topic === id` (a 0.9 root), is in the main chat |
| `thread` | main chat: `panel:<sessionId>` (two parts) or the chat app's key; in a thread: the thread's key, `panel:<homeSessionId>:<rootId>` or the chat key |
| `replyTo` | only when a message in a thread quotes one other than the root |
| `ticket` | a task's report, or a message that went to that task |
| `movedTo` | 0.9 data only; such a row is in the target thread |
| `quote` | in `GET messages?bot=` only, on a message inside a thread: `{ id, from, text, who?, via? }`, the message it quotes (text clipped to 140 characters). The person's: the one they replied to (`replyTo`, else the root); a bot's: the person's latest message of the thread before it, else the root |

A new top-level panel message: `{ id: 'p…', from: 'user', to: bot, chat: bot, kind: 'user', thread: 'panel:<sid>' }`;
the bot's answer: `{ from: bot, to: 'user', chat: bot, kind: 'reply', thread: 'panel:<sid>' }`. Answers in a
discussion carry the thread's `thread` and `topic` (a discussion's Session answers in its own Thread when its turn
names none).

### Routes
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `messages` | `?bot=<id>&limit=200` | `{ items, threads }`: `items` is the chat as it was said, oldest first, the messages of threads among the rest with their `quote` (the window as it is: a root older than it is not brought along); `threads: { [rootId]: ThreadSummary }` for each item that has a thread |
| GET | `messages` | `?bot=<id>&topic=<rootId>&limit=500` | `{ items: [root, ...replies], threads: { [rootId]: ThreadSummary } }` |
| POST | `send` | `{ to, text, replyTo? }` | `{ ok, sessionId, message }`; `message.topic` is the root id when it went into a thread. `replyTo`: a main-chat message opens (or joins) its thread; a message in a thread keeps it in that thread, quoted. Refused: `/new` in a thread (`a thread has no new topic: send /new in the main chat`), a message of another bot's chat (`that message is not in this chat`) |
| POST | `threads/seen` | `{ bot, root }` | `{ ok, unread: 0 }`: the thread's replies up to now count as read (kept in `discussions.json`, so the same on every device) |

```ts
ThreadSummary = {
  key: string,                       // the thread's key
  count: number,                     // replies: what people and bots said, task reports (system lines left out)
  lastAt: number,                    // ms of the latest reply, 0 for none
  last: { from: string, text: string } | null,  // text clipped to the preview length
  unread: number,                    // bot replies after the person last looked (threads/seen)
  running: boolean,                  // the discussion's Session runs, or a task it follows is working
  answering: boolean,                // the discussion's Session runs (the chat shows the bot at work at its end)
  tickets: TicketRow[],              // tasks subscribed to the thread, archived ones left out
}
```

`GET state` adds `botsVersion` (the Bots version this Harness process loaded; `version` stays the store's revision)
and `rotatedAt` (ms of the latest time Bots archived a conversation: a new topic, or an idle thread; 0 since start).
The panel shows a banner when `botsVersion` differs from its own version, and selects itself again when Harness
closes it within 3 s of `rotatedAt` (Harness closes the active panel when the Session behind it is archived).

### Routing
- A top-level panel message goes to the bot's home as in 0.9, logged before it is handed over (`bots:panel:<id>`),
  without a thread id: a router home gets `[Panel]` and `Open tasks: …`, another home no header. When the panel's
  threads had messages since the home last heard (`discussions.json` `told[botId]`, at first the time the file began;
  and not before the current topic started), the message comes after this note (at most `NEWS_MESSAGES` = 16, the
  latest; each clipped to 300 characters; chat-app threads, bot-to-bot messages and system lines left out):
  ```
  [Threads] Since your last message here, the user replied to messages of this chat in threads (each its own conversation, which answered there). So you know what was said; nothing to answer:
  - On your message: "约 39.5 万。要不要我写个小脚本？"
    The user: "什么情况下你会这么做？"
    You: "当你会反复问同一个数字的时候。"
  ```
  The root is named `your message`, `the user's message` or `@handle's message`; a teammate's line `@handle`.
- A reply goes to a task when the root is that task's own message (`root.ticket`, live: not archived, not stopped by a
  person): the task is subscribed to the thread and `Ticket += { showIn?: string }` is set to the thread's key, where
  its later `done` / `question` / `blocked` reports are shown. A 0.9 topic with subscribed live tasks and no
  discussion goes to its tasks too. The note `[follow_up] …` is injected into whoever asked for each task: the home,
  or the discussion that opened it.
- Any other reply goes to the thread's discussion, forked the first time:
  1. at the replied message's anchor (where it sat in its Session, noted as events arrive; for a person's message,
     the end of the turn that took it, so the answer it got is included);
  2. else at its place found in the Session's log by time (`seqByTime`: a bot's message at the last event at most
     1.5 s after it was logged; a person's at its own `user/message` event — the first one from 50 ms before it was
     logged on — then the end of that turn), in the Session the message was said in (its `sid`, the panel Thread's
     session, the bot's own task, or the bot's home);
  3. else at the latest finished turn of the bot's home. Such a discussion, or one whose `atSeq` fork failed and was
     retried without it, is `exact: false`.
  The fork is given the bot (tools, persona, memory; a router home's fork stays a router) and its model (a fork starts
  on Harness's default), and titled `<bot> · <the start of the root>`. Its replies are logged in the thread; topic
  rotation, `topics.noteCall` and `noteTask` look only at the home.
- In a discussion the person talks to its bot even after that bot opened tasks there: such tasks have the thread as
  origin, report into it, and their relays and reminders reach the discussion (`requesterAgent`).
- The first message of a discussion carries (claimed before the hand-over, so two first replies at once carry it once):
  ```
  [Thread] From here on this is a thread: the user replies to this message of @forge above: "…". Answer about it.
  What the main conversation said after that message is not visible here.
  ```
  With `exact: false`: `… this message of @forge: "…". Answer about it.` and `The conversation above may go on past that
  message; stay on that message.` A quote of another message of the thread adds
  `In reply to <who>: "…"`; later quotes get `[Panel]\nIn reply to <who>: "…"`.
- Errors: `threads need the Web profile (no session controller here)`; `this DeepSeek Harness cannot fork a
  conversation; update it to reply in a thread`; `the conversation that message was said in is gone; send it as a new
  message instead`. The message is then dropped from the chat (`hidden`).
- A discussion quiet for 24 h (`IDLE_ARCHIVE_MS`) is archived in Harness by the task upkeep; the next reply takes it out
  of the archive (`workspaceRegistry.unarchiveSession`), or, when that fails, forks it again from its own latest turn.
  Removing a bot archives and forgets its discussions; a model change applies to them too.

### Chat apps
- Unchanged from 0.8: a leading `@handle` goes to that bot; a Thread with live subscribed tasks gives them the message.
- Otherwise a message in a Thread (`kind:appKey:chatId:rootId`) goes to that Thread's discussion when there is one;
  when there is none, it forks one at the Thread's anchor (the home's latest exchange there: the message it took, its
  answer, the end of that turn) or at the anchor of the root message (`chat:<appKey>:<chatId>:<messageId>`, a message
  the bot took in or sent), if that Session is the bot's. The Thread's first message, one that arrives while the home is
  still on that Thread, and a message of a whole chat go home as before. The first message in a discussion gets
  `[Thread] From here on this is a thread: the user replies to an earlier message of the conversation above. …` before
  its source line.
- Connectors' `send(chatId, text, opts)` resolves to `{ ids: string[] }`, the chat app's ids of the messages it made
  (Telegram `message_id`, Slack `ts`, Discord `id`, Feishu `message_id`). `createChannels` takes
  `onSent({ tag, appKey, chatId, threadKey, ids })`, called after a send made with a `tag` (`noteReply`, `replyTo`,
  `post` take one; Bots tags a home's replies and `bot_reply` with `{ sessionId, seq }`), and `homeKey(sessionId)`, the
  Thread a Session's input without one belongs to (a discussion's own key; default `panel:<sessionId>`).

### Storage
`~/.dsh/cache/bots/discussions.json`:
```ts
{
  items: { [threadKey]: {
    key, botId, sessionId, rootId,
    source?: { sessionId, seq? },    // where it was forked
    title?, createdAt, lastAt,
    archivedAt?, noted?: true,       // noted: its first message carried the [Thread] note
    exact?: false,                   // forked at the latest turn, not at the root
  } },
  anchors: { [ref]: { sessionId, seq, at } },  // ref: `msg:<id>`, `chat:<appKey>:<chatId>:<messageId>`, or a Thread key; newest 4000
  seen: { [rootId]: number },        // when the person last looked at that thread
}
```
Discussions past 2000 lose the oldest archived ones. A new discussion is written at once; anchors and the rest within
200 ms.

## v0.11 — requests (needs), one dispatcher mode, no empty answers

The panel says **request**; the code, routes, tools and files say **need**. A need is one thing the person asked for,
above the tasks that do it.

### Needs
```ts
Need = {
  id: string,                    // n + 8 [a-z0-9]
  title: string,                 // ≤ 80 characters: the request restated for the person, in their language
  auto?: true,                   // titled with the person's words: the dispatcher did not restate it
  botId: string,                 // the dispatcher that named it
  origin: { threadKey?, via?, who? },
  asks: { id?, at, text, via?, who? }[],   // the person's messages about it; the first kept, then the latest 19
  tickets: string[],             // top-level tasks; a sub-task counts through the task that opened it
  createdAt, updatedAt,
  closed?: { at, by: 'user' | 'dispatcher' },  // dropped
  mergedInto?: string,           // merged away: a pointer to the need that took it
  snapshot?: { status, done, total, failed, stalled, at },  // its last status, for when its tasks are pruned
}
NeedRow = {
  id, title, auto?, status: 'waiting' | 'working' | 'failed' | 'done' | 'stopped',
  done, total, failed?, stalled?, waiting?: string[] /* task ids asking the person */,
  bots: string[], via?, who?, threadKey?, asked? /* the first message, ≤ 200 */,
  latest?: { status, at, botId, ticket, preview },   // a question waiting for the person first, else the latest report
  createdAt, updatedAt, endedAt?, closed?,
}
NeedView = NeedRow & { asks, tickets: TicketRow[], results: { at, botId, ticket, text }[] /* done reports */ }
```
Status (first match): dropped → `stopped`; a task in `question`, or open with an unanswered `blocked` → `waiting`; a
task open → `working`; all ended with one `done` → `done`; one `failed` → `failed`; else `stopped`.

Which need a task counts toward, when the router home opens or adds to one with `bot_send_message`: the one `need`
names by id (an unknown id is refused before anything opens); the need the task already counts toward (a follow-up:
the person's words of the turn join it); one this turn made under the same words (parallel calls); a new one when
`need` restates a request; with no `need` in a turn the person spoke in, a new `auto` one titled with their first
message (≤ 60 characters). Work nobody asked for (a teammate's message, a schedule) counts toward none; `need` from
any other conversation is ignored. The result's text ends with `It counts toward need <id> ("<title>").`

The router reads `Open needs: <id> "<title>" (<status>[, <done>/<total> done]); …` (open needs and ones changed in
the last day, ≤ 8) after `[Panel]` in a panel message, and as its own text block before a chat message's source line.

### Tools
- `bot_need { need, action: 'rename' | 'merge' | 'drop', title?, into? }` — the router home, or a conversation of no
  bot. `drop` stops the need's open tasks. Result `{ ok, text, need: NeedRow }`.
- `bot_recall` reads `needs` (`{ items: { id, title, status, done, total, …, tasks }[] }`, newest 30) and `need/<id>`.

### Routes
| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `needs?status=&limit=&offset=` | | `{ items: NeedRow[], next_offset }`, newest change first; `limit` ≤ 300 (100) |
| GET | `needs/<id>` | | `NeedView` (a merged id answers with the need that took it) |
| POST | `needs/<id>/rename` | `{ title }` | `{ ok, ...NeedView }` |
| POST | `needs/<id>/drop` | `{}` | `{ ok, ...NeedView }`: open tasks stopped by the user |

`state.needs = { waiting: number, working: number }`.

### Storage
`~/.dsh/cache/bots/needs.json` holds `{ version: 1, needs: Need[] }`, mode 600. Upkeep keeps the newest 500 settled
needs (done, failed or stopped) and every open one.

### Empty answers
Harness's pi-ai adapter turns an answer that stops with no content into `EMPTY_RESPONSE` (`model "…" returned a
completed response with no content`), retries it, then fails the turn. Every persona tells the bot to write only
`NO_REPLY` when nothing needs saying; a final text that is that marker alone (any case, in backticks or with a full
stop) is never logged as a reply, sent to a chat app or kept in a task's log. A task whose turn still fails with
`EMPTY_RESPONSE` is not failed or retried by the plugin (the watchdog still asks one that never reports), and a run
that ended so is not marked `error`.

## v0.12 — the board: cards and projects

The panel shows needs as cards on a board, in columns by status, and the person may file one there themselves. A
**project** groups cards and numbers them (`OPC-12`); its tasks work in its folder and read its brief.

### Projects
```ts
Project = {
  id: string,                    // pj + 8 [a-z0-9]
  key: string,                   // 2–6 [A-Z0-9], a letter first, unique; cards read `${key}-${number}`
  name: string,                  // ≤ 60 characters
  brief: string,                 // ≤ 4000 characters; every task of the project reads it
  dir: string,                   // '' or an absolute path to an existing folder other than / (`~/` expanded on save)
  last: number,                  // the last card number given; numbers only go up
  createdAt, updatedAt,
}
ProjectView = { id, key, name, brief, dir, next /* last + 1 */, counts: { todo, working, waiting /* + failed */, done, stopped }, createdAt, updatedAt }
```
A key left out on create is suggested from the name: initials of its words (`One-person company` → `OPC`), pinyin
initials of a Chinese name (`内容工作室` → `NRGZS`), the first three letters of one word, numbered when taken (`OPC2`).
`~/.dsh/cache/bots/projects.json` holds `{ version: 1, projects: Project[] }`, mode 600, at most 100 projects; a file
that is not JSON in this shape is set aside as `projects.json.corrupt-<ms>`.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `projects` | – | `{ items: ProjectView[] }`, by key |
| POST | `projects/save` | `{ project: { id?, name, key?, brief?, dir? } }` (no id = create; only the fields given change) | `{ ok, project: ProjectView }`; errors: `a project needs a name`, `the key OPC is taken by another project`, `a project key is 2–6 capital letters…`, `there is no folder …`, `… is a file, not a folder`, `the folder must be a full path …` |
| POST | `projects/delete` | `{ id }` | `{ ok, cards }`: its cards are filed under none (number dropped); tasks with a Session keep it, tasks not started yet lose `projectId` and use the folder for tasks without a project |

### Cards (needs)
```ts
Need += {
  projectId?: string, number?: number,   // filed under a project with its number there (both or neither)
  description?: string,                  // ≤ 20 000 characters, from the board
  todo?: true,                           // filed for later: nothing handed out yet
  closed?: { at, by, outcome?: 'done' }, // outcome 'done': marked done by hand (else dropped)
}
NeedRow += { ref?: 'OPC-12', projectId?, number? }   // status adds 'todo'
NeedView += { description? }
```
Status (first match): closed → `done` with `outcome: 'done'`, else `stopped`; `todo` with no task → `todo`; then as in
0.11. Work handed out (a task counted toward it, a start, or a merge into it) takes a card out of To do and makes a
closed one live again. A start that reaches no one puts back what it changed (To do, dropped, the dispatcher that
named it). `openNeedsOf` (the dispatcher's `Open needs:` line) leaves To do out and writes `n… OPC-12 "title" (status…)`.
`state.needs` still counts `waiting` (with `failed`) and `working` only.

A card the person files gets `origin: { via: 'board', who: 'the user' }`, `asks: [{ at, text: title + '\n\n' +
description, via: 'board' }]` and `botId` = the dispatcher (the one that starts it, when it is started later).

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `needs?project=<id>\|none` | also `status`, `limit`, `offset` | as in 0.11, filtered by project |
| GET | `needs/<ref>` | `ref`: an id or a card (`OPC-12`, any case) | `NeedView` |
| POST | `needs/create` | `{ title, description?, projectId? (id or key), assignee? (a bot), start? (default true) }` | `{ ok, ...NeedView, startError? }`: a card that could not be handed out is kept, in To do, and `startError` says why |
| POST | `needs/<ref>/start` | `{ assignee? }` | `{ ok, ...NeedView }`; only a card in `todo` or `stopped` (`this card is under way already: …`) |
| POST | `needs/<ref>/done` | `{}` | `{ ok, ...NeedView }`: open tasks ended `done` by the user, the card closed with `outcome: 'done'` |
| POST | `needs/<ref>/save` | `{ title?, description?, projectId? ('' for none) }` | `{ ok, ...NeedView }`; another project gives it the next number there, and the tasks it opens from then on work on that project (tasks it has keep theirs). Everything is checked before anything changes |

Starting a card:
- **To the dispatcher** (no `assignee`, or the dispatcher, or a lone dispatcher): `send` as a panel message whose text
  is the title and description, logged with `need: <id>` (`GET messages` adds `card: { id, title, ref? }` to it). The
  router reads, after `[Panel]` and `Open needs:`, `[Card OPC-12] The user filed this on the board as need n… ("…") in
  project OPC (…) and handed it to you. The tasks you open for it count toward it (pass need n…; they work in the
  project's folder). When you answer it yourself without handing anything out, mark it done with bot_need (action
  done).` A lone dispatcher reads the project's folder instead and marks it done itself. In that turn a
  `bot_send_message` with no `need`, or with a restatement when the card is all the person said, counts toward the
  card; the card's text joins no need as new words, and a card named in its own turn takes none of the turn's other
  words. New work in a turn that holds several cards, or a card and other messages of the person's, must name its need
  (`this turn has several cards from the board: pass \`need\` …` / `this turn has card n… "…" and other messages from
  the person: pass \`need\` …`); a message added to a task already counted toward a need never moves it.
- **To one teammate** (`assignee`, router mode): a ticket `{ requester: { kind: 'session', sessionId: <dispatcher
  home>, botId: <dispatcher> }, origin: { threadKey: 'panel:<home>', who: 'the user' }, board: true, projectId }`,
  counted toward the card before it starts. The dispatcher's chat logs `{ from: 'user', to: <bot>, chat: <dispatcher>,
  kind: 'user', thread: 'panel:<home>', ticket, need }` (no `sid`: pending until the task starts); a reply to it goes
  to the task, and its reports show in that chat as for any task the dispatcher opened from the panel. The dispatcher
  gets `[Board] The user handed card OPC-12 "…" (need n…) to @bot themselves: task t…. …` injected (id
  `bots:board:<ticket>`). The worker reads `New task t… from the user, from the board: …`.

### Tasks
`Ticket += { projectId?: string, board?: true }`. A ticket's Session is made in its project's folder
(`workspaceRegistry.create(dir, name)`, which returns the existing workspace of that folder; `cwd` when Harness has no
registry); a project whose folder is gone fails the start (`did not start: the folder of project OPC, …, is gone; set
another one on the board`). A sub-task takes its parent's `projectId`. A ticket the router opens is counted toward its
need before it starts, so it gets the need's project then. The assignment adds `It is for card OPC-12 ("…") of project
OPC (…).` after its origin line; the task's persona adds `## The project` (key, name, folder, brief).
`TicketView += { need?: { id, title, ref? } }`; `TicketRow += { board?: true }` (the panel reads such a task as asked by
the person, from the board).

For a ticket without a `projectId`, the target bot's handle selects an existing folder from `bots.config.workdirs`.
New home sessions use the same setting. Both fall back to the shared `workdir` if the handle has no usable folder.
A ticket with a `projectId` whose project has no folder configured uses the shared `workdir`.

### Tools
- `bot_send_message += { project? }` — router home only: a project key (or id) a new request belongs to; an unknown one
  is refused before anything opens (`no project "X"; projects: OPC (…), …`). It files the need when it has no project
  yet; the result says `It counts toward need n… (card OPC-12) ("…").` `need` takes a card (`OPC-12`; an unknown one:
  `no card OPC-99 on the board. …`). A card in To do is refused unless it came in this turn (`need n… is a card the
  person keeps in To do; …`): only the person starts it.
- `bot_need` takes a card (`OPC-12`) for `need` and `into`, and two more actions: `done` (open tasks closed, the need
  closed as done) and `file` (`project`: a key; empty for none). It works in the dispatcher's home whether it routes or
  not.
- `bot_recall` reads `need/OPC-12`; `needs` items add `card`.
- A router dispatcher's persona adds `## Projects` (each `- KEY — name: the brief's first line`, and when to pass
  `project`); prompts read the projects as they are assembled, so a change applies at the next step.

## v0.13 — cards named in messages, and cards that wait for others

### Cards named
A card reference is `KEY-N` (any case) with no letter, digit or `-` before it and no letter or digit after it, naming
an existing card (`needs/<ref>` finds it). In a message to the router home (the panel, a thread of it or a chat app):
- **Leading**: a message that starts with one (spaces before it allowed) whose card has exactly one live task (not
  archived, not stopped by a person) goes to that task as the person's message, like a reply in a task's thread: from
  the panel it is logged in the dispatcher's chat as `{ from: 'user', to: <bot>, chat: <dispatcher>, kind: 'user',
  thread: 'panel:<home>', ticket, need }` (`bots:panel:<id>:<ticket>`); from a chat app (`createChannels` dep
  `cardRoute(owner, text) => {need, ticket} | null`, called for a message `routeInbound` sends to the router without
  an `@handle`) through `toTickets` with `meta.card`. A task that answers the person itself is subscribed to that
  Thread and `showIn` it. The dispatcher gets a `[follow_up]` note injected. Its words join the card's need. When the
  task does not take it, the message goes to the router as usual.
- A `done` report while a person's message to the task waits unread (pending in its conversation, or parked for a slot)
  is passed on as usual, but the task stays open (`addReport(…, { keepOpen: true })`); the worker's tool result says the
  message comes next and to report again. Its next `done` ends it. This holds for any task, not only a card's.
- **Otherwise** the router reads, after `Open needs:` (a panel message's header; a text block before a chat message's
  source line), `Cards named: n… OPC-12 "…" (working, 1/2 done), open tasks t… (@forge, working); …` (≤ 5 cards; a card
  in To do adds `— in To do: it starts when the person says so`). The turn's asks carry `refs` (need ids named), and
  `bot_send_message` with `need` = a card in To do is allowed when the person named it in that turn.

### Waiting cards
```ts
Need += { after?: string[] /* need ids, ≤ 10, not its own */, startWith?: string /* a bot id; none: the dispatcher */ }
NeedRow += { after?: { id, title, status, ref? }[], afterStuck?: true, startWith? }   // a card in To do only
```
Only a card in To do waits (`only a card in To do waits for others: this one is under way already`). Refused: an
unknown card (`no card X to wait for`), itself, more than 10, and a loop (`OPC-3 already waits for this card: they
would wait for each other`). Its wait is `ready` when every card it waits for is `done` (a merged one is followed, a
pruned one dropped from the list), `stuck` when one is `stopped` or `failed` (`afterStuck`: it does not start by
itself), else waiting. After any change of a need (on the next tick) and at every upkeep, each ready card starts with
`startWith` as the assignee; a start that fails is tried again 4 minutes later at the earliest. It starts as a card
does (0.12) with, for each card it waited for, `It waited for OPC-11 ("…"), which is done now: "<its latest done
report, ≤ 600 characters>"` (and `… (bot_recall need/OPC-11 reads all of it)` when cut): below its text for a task
of one bot, or on the lines after the `[Card …]` header, which then reads `… to start once other cards were done; it
starts now.`
Starting it by hand starts it at once.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `needs/create` | `+= { after?: (id \| ref)[] }` | with `after`: kept in To do, waiting, `assignee` as `startWith` (`start` does not matter then) |
| POST | `needs/<ref>/save` | `+= { after?: (id \| ref)[] ([] for none), startWith?: bot ('' for the dispatcher) }` | checked before anything changes |

`bot_need` adds `action: 'after'` with `after` (references or ids, comma-separated; empty for none) and `start_with`
(`@handle`). A router persona with projects reads what `Cards named:` means and when to use it.

## v0.14 — GitHub issues

A chat channel of kind `github` (catalog app `github-issues`; fields `token` (secret), `repos` (`owner/repo`, comma
separated), `label` (default `bots`)). `lib/channels/github.mjs` polls; there is no webhook and no public address.

### Transport
- Every 60 s, per repository: `GET repos/{repo}/issues?labels=…&state=open&sort=updated&direction=asc&since=…` and
  `GET repos/{repo}/issues/comments?sort=updated&direction=asc&since=…`, each with `If-None-Match` (a 304 costs no rate
  limit), up to 5 pages. Pull requests are left out. A 401 stops it (`GitHub rejected the token: …`); a 403 or 429
  waits for the reset (≤ 15 min).
- An issue is passed on once (`messageId` `i<id>`, `threadId` its number, `text` `#N title` and its body, cut at 8000
  characters with its address, `issue:
  {repo, number, title, body, url, author, labeledBy?}`); afterwards only comments on issues passed on (`c<id>`;
  comment ids only grow, so an edited one is not new), never the token's own account's or a body holding
  `<!-- dsh-bots -->`.
- `trusted`: an issue whose author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`, or whose latest
  `labeled` event (for the label) has an actor that `GET repos/{repo}/collaborators/{login}` answers 204 for (cached 10
  min); a comment by such an author.
- Cursors (`memo`, in `channels.json` under the channel's record): `{ repos: { [repo]: { since, comments, lastComment,
  issues: number[] (≤ 1000) } } }`. A first start sets them to now.
- `send(repo, text, { threadId })` posts `text` + `\n\n<!-- dsh-bots -->` as a comment on that issue (`{ ids: [id] }`);
  without an issue it throws. `typing` does nothing. Exports `VOUCHED = true`, `MARKDOWN = true`, `TEXT_LIMIT = 60000`.

### The hub
- A module with `VOUCHED` pairs nobody: no pairing code, no welcome or greeting answers. A message with `trusted: true`
  counts as a person's (not stored); any other is ignored without an answer and counted (`view.ignored`).
- Its Threads are reachable for replies and reports though nobody is paired (`lookupThread`).
- `view` adds `vouched: true, watching: { repos, label }`.
- A message with `issue` calls `deps.fileIssue(owner, issue, { threadKey, who, via })` before it is routed; a need id
  back is passed on as `meta.issueCard`.

### Cards from issues
`fileIssue` files a card unless one already links that issue: `{ title, description: body, origin: { threadKey, via:
'github', who }, asks: [title + body], links: [{ kind: 'github', ref: 'owner/repo#N', url }], todo: true }`, under the
project whose `repo` is that repository (with its next number). `deliver` gives the bot, before the source line, the
card's header — `[Card WEB-1] @kada asked for this in GitHub issue acme/site#12; it is on the board as need n… ("…") in
project WEB (…). Answers in this thread are comments on the issue, which everyone who can see the repository reads. …`
— logs the message with `need`, and starts the card once the bot has it (`botId` = that bot). In the dispatcher's
turn, its new work counts toward the card as for a board card (0.12).

`Need += { links?: { kind: 'github', ref, url? }[] }` (≤ 10), on `NeedRow`. `Project += { repo: string }` (`owner/repo`,
from a github.com address too; unique: `acme/site belongs to project WEB already`), on `ProjectView` when set and in
`projects/save`.

## v0.15 — team leads

A team whose work runs as a pipeline is led by the bot that delivers it; the dispatcher stays the one front desk.

```ts
Bot += { lead?: true }        // only with `team`, never the dispatcher; one per team (saving one clears the others)
Team += { lead?: string }     // the key of the bot that leads it: dev → builder, content → writer (Quill), research → writer (Memo); opc: none (ops, Compass, from 0.16)
TeamView += { lead?: string }
Settings += { teamLeads: null | 'given' }   // 'given' once teams hired before 0.15 got their leads
```

- **Hiring** sets `lead` on the template's lead bot. `POST save` takes `lead` (true/false) for a bot of a team;
  `setPrimary` clears it on the new dispatcher. `bot_update` adds `lead` (refused for a bot of no team, and `true`
  for the dispatcher).
- **The dispatcher** (router home): `bot_send_message` with `to` a member of a team that has a lead, not the lead,
  is refused (`@tester is on Software squad, which @builder leads: hand the team's work to @builder, …`) unless a
  message of the person's in this turn names that bot: its `@handle`, or the first word of its name (3+ ASCII
  characters), as a word of its own, in any case (`namesBot` in `lib/teams.mjs`). Adding to an open task of a
  member (`ticket`), a card handed to a member on the board, and other bots' messages are not checked.
- **Prompts**: the roster writes a led team as `- Software squad, led by @builder:` and tags the lead `(lead)`; a
  router persona reads that such a team takes its work through its lead. The lead reads `## You lead Software
  squad` (its teammates; plan first and check a bigger plan with the person; hand parts out as sub-tasks; answer
  once; another team's work goes to its lead). A member reads that the team's work comes to it from the lead. Bots
  of a team without a lead read nothing new.
- **Templates**: Builder plans a goal as at most 5 changes and checks a bigger plan with the person (persona and
  bio); the software squad's and content studio's kickoffs hand the start to Builder and Quill; the content studio's
  **Plan this week** has Quill propose the topics, from Scout's research.
- **Teams hired with 0.11.1–0.14** (`planLeadMigration`, at start, after the 0.11.1 migration): once (`teamLeads`),
  a led team none of whose bots leads it gets the bot with its lead's handle; a persona, bio or routine that still
  reads exactly as 0.11.1–0.14 hired it (`lib/teams-0.14.mjs`) takes its 0.15 text. `migrateTeams()` answers
  `{ …0.11.1 plan, leads: { bots, edits } }`.
- **Panel**: a lead is tagged **Lead** in the rail and on the team templates; a team bot's Profile has a **Leads …**
  switch.

## v0.16 — leads for every team, teams for your bots, project memory, GitHub Enterprise

### Every team has a lead, listed first

```ts
Team.opc.lead = 'ops'          // Compass (@compass), a bot of its own; every team's lead is first in `bots` (content: Quill)
TeamBot(ops).tasks = [Inbox sweep, Weekly numbers, Market pulse]   // were opc `desk`; `desk` keeps Morning brief, Weekly review
ADDED_LEADS = ['opc']          // lib/teams.mjs: templates whose lead is a bot that teams hired before lack
State += { leadOffers: { team, name, lead: { key, handle, name, bio, color, tasks: {en,zh}[] } }[] }
Settings += { leadOffers: { [teamId]: 'dismissed' } }
```

- `leadOffers`: a team of `ADDED_LEADS` that is hired (a non-dispatcher bot with that `team`), none of whose bots
  leads it or has the lead's handle, and not dismissed. The panel shows the first as a banner (**Add {name}** /
  **No thanks**).
- `POST teams/add-lead { team, lang }` → `{ ok, team, bots: [the lead], dispatcherId, kickoff, skipped, moved }`:
  `hireTeam(team, lang, { only: [lead] })` (that member alone, `lead: true`, its scheduled tasks; no desk tasks).
  Refused (`… has its lead already, or was not hired`) when there is nothing to offer.
  `POST teams/add-lead/dismiss { team }` → `{ ok, leadOffers }`.
- `hireTeam` (`moved` on `teams/hire` too): a member hired again gets no second routine of a title it has; when the
  dispatcher existed before, its scheduled tasks whose title and prompt are still one of the lead's tasks in either
  language (`deskTasksOfLead` in `lib/team-migration.mjs`) are deleted, and only those whose twin the lead now has, so
  a routine that could not be made on the lead stays on the dispatcher; an edited one stays.
- The 0.11.0 migration (`planTeamMigration`) still moves a member routine the lead now runs to the dispatcher (as
  0.11.1–0.15 had it); it moves on when the lead joins.
- Names (`lib/teams-0.15.mjs`, in `planLeadMigration` at every start): `Quill 写手` → `Quill 主编`, `Memo 撰稿人` →
  `Memo 主笔` where still as hired.
- The rail (`groupByTeam`) and the roster (`rosterLines`) list a team's lead first.

### A team for any bot

- `POST save` takes `team`: a hired team's id, or `''` for none. A changed `team` is checked (`teamArg`): a team of
  the templates one of whose non-dispatcher bots belongs to it, never for the dispatcher (`the dispatcher belongs to no
  team`); refused → `{ ok: false, reason }`.
- `bot_create` and `bot_update` take `team` (id, or name in English or Chinese, any case; `none` takes it out).
  `bot_update lead` is refused for a bot of no team (`@x is part of no team; only a team has a lead`). `bot_list`
  writes `, team <id> (<name>)[, lead]` in each bot's brackets.
- Store: a bot whose `team` changes keeps `lead` only when the same save sets `lead: true` (`normalizeBot`), so a lead
  that moves does not take the lead of its new team.
- Panel: **Team** (`data-dsh-bots-new-team`, `data-dsh-bots-team-select`) in **New bot** and on a non-dispatcher's
  Profile, offering **No team** and the hired teams; the **Leads …** switch follows the team chosen and is off after a
  move.

### Project memory and a last day for notes

```ts
Note += { until?: 'YYYY-MM-DD' }        // its last day; a pinned note never runs out
NotesFile += { projects: { [projectId]: Note[] } }   // ids 'p-…', at most PROJECT_CAP = 60 per project
Edit (add | update | merge) += { until? }           // update: until null or '' takes it away
```

- A memory scope is `'team'`, a project's id (`pj` + 8, `isProjectScope`) or a bot's id. `memory.prune(today)`
  removes unpinned notes past their day in every scope; `dropProject(id)`; `projectIds()`; `search(q, { bot, projects })`.
- Prompt: `memoryText` leaves out notes past their day, writes `(until YYYY-MM-DD)` after a note that has one, and, for
  a task conversation whose ticket has `projectId`, adds `### Project memory: KEY · Name (every task of this project
  reads it)`. Its rules: shared notes only for what every bot needs in every piece of work; one project's matters in
  `project`; never the state of work, where a file is, or who is on the team; `until` for dated notes.
- Reflection (`reflectionPrompt`): with the task's project, `{summary, notes, team, project}`; the same rules, and
  today's date. Consolidation (`dream`): `prune(today)` first (`result.expired`), then each bot (rules added), then the
  team with every project's notes (`dreamTeamPrompt({… projects, today})` → `{digest, team, projects: {KEY: edits}}`;
  the projects' edits go first, by key; a team note about one project moves there). An answer naming a key that is no
  project's keeps every team note it would remove.
- `memory_save`: `scope: 'self' | 'team' | 'project'`, `project` (key; default the task's project, else refused:
  `this conversation works on no project …`), `until` (`YYYY-MM-DD`, else refused). With `replace_id` the note takes
  the `until` given, or none. A model's `update` keeps a note's `until` unless it gives one (`null` removes it). `memory_forget` finds a `p-` id in
  whichever project holds it. `memory_search`: a task searches its project's notes, elsewhere every project's;
  a project note reads `(project KEY)`.
- Routes: `GET memory?bot=<projectId>` → `{ scope, project: { id, key, name }, notes, today, tz }`; `GET memory?bot=team`
  adds `projects: { id, key, name, count }[]` and `today`; a bot's view adds `today`. `memory/put` and
  `memory/delete` take a project id as `scope`; `memory/put`'s note takes `until` (`''` clears it).
  `projects/delete` drops the project's memory.
- Panel: **Team memory** has **Shared notes** and **Project memory** (a project picker, then its notes); a note shows
  `until …` or `past its day …`; adding and editing take a date.

### GitHub Enterprise and the project folder

- A repository is `owner/repo` on github.com and `host/owner/repo` on any other server (`cleanRepo` in
  `lib/channels/github.mjs`: from `https://host/owner/repo[/…]`, `git@host:owner/repo.git`,
  `ssh://git@host[:port]/owner/repo`, or a bare `host/owner/repo`; a host needs a dot or a port, so the kept form reads
  back the same). Projects, channel
  `repos`, `chatId`, `issue.repo` and link refs (`host/owner/repo#N`) all use that form; a link's `url` may be any
  http(s) address.
- A channel's API is `https://host/api/v3/` (`https://api.<host>/` for `*.ghe.com`; `api.github.com` without a host,
  `apiBaseOf`); a channel whose repositories are on more than one server stops with a fatal error. `send` refuses a
  repository on another server. The channel panel links `repoUrl(repo)/issues?…`.
- The project dialog has **Choose folder…** (`data-dsh-bots-project-pick`) when the Host offers a folder dialog
  (`__DSH_DIRECTORY_PICKER__`, else `uiWorkspace.pickDirectory`); the path it returns fills the folder field.

## v0.17 — images in messages, your own teams

### Images

```ts
Image = { id: string /* the attachment id */, url: '/__dsh_bots/image/<id>', width: number, height: number, name?: string }
Message += { images?: Image[] }          // the timeline (messages, threads) and send's answer
TicketView += { images?: Image[] }       // what its assignment carries
```

- `POST images` `{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: base64 | data URL, name? }`
  → `{ ok, image: Image }`. Harness's attachment store (`ctx.attachments.admitPromptContent`) checks the bytes against
  the type, normalizes and keeps the image; a refusal comes back as `{ ok: false, reason }` in its words. The body may
  be up to 40 MB (other routes 4 MB). Without an attachment store: `sending images needs a Harness with attachments`.
  The panel uploads each image as soon as it is attached, so a message only names them.
- `POST send` and `POST tickets/<id>/message` take `images: string[]` (ids, at most 10). An id no message or upload
  gave is refused (`no image <id>: …`). With images, `text` may be empty.
- `GET image/<id>`: the bytes, read through `ctx.attachments.readImage` (which verifies them against the reference),
  `content-type` the image's, `cache-control: private, max-age=31536000, immutable`; 404 for an id no message named.
- `images.json` (`lib/images.mjs`): attachment id → `ImageAttachmentRef`, the newest 5000. Refs come from uploads and
  from the `image` blocks of every `user/message` event in a bot's home or task conversation.
- A chat message's images (Feishu, see the connector contract) are stored the same way and reach the bot, a
  discussion or a task follow-up as those blocks after the message's text and context; the chat message logged in
  the timeline keeps their ids, and the work the turn hands out carries them like a panel message's.
- To a bot, a message's images are `{ type: 'image', attachment: ImageAttachmentRef }` blocks after its text, then
  one text block: `[Image attached: <id> (<name>). To pass it on to a teammate, name its id in \`images\`.]`
  (`N images attached: …` for several). Logged messages and tickets keep `images: string[]` (ids).
- The images of a home turn's messages (not reports) are the turn's (`turnState.images`). `bot_send_message` takes
  `images: string[]`: left out, a new task or a message carries the turn's images, or, from a task conversation, the
  task's; `[]` carries none. Adding to a task (`ticket`) carries only images it does not have; from a task's own
  conversation, only the ones named. Reports carry none. The answer says `It carries N images.`
- A ticket keeps `images` (`tickets.create({ images })`, at most 10); its assignment (start, and a new conversation on
  recovery) has their blocks after the text. A message added before it starts adds its images to the ticket.
- Panel: an image button (`data-dsh-bots-attach`, `data-dsh-bots-attach-input`) in the chat, thread and task
  composers; paste and drop on the composer attach images; attached ones show above the box
  (`data-dsh-bots-attached-item`: `uploading` | `ready` | `error`). Messages show thumbnails
  (`data-dsh-bots-msg-image`) that open a lightbox (`data-dsh-bots-lightbox`; arrows, Esc).

### Your own teams

```ts
TeamView = { id, name: { en, zh }, tagline: { en, zh }, color, template?: string, custom?: true, renamed?: true,
             members: string[] /* lead first */, lead: string | null }
State += { teams: TeamView[] }                      // hired template teams, then your own
Settings += { teams: { [id]: { name?, tagline?, color?, custom?: true, at? } } }   // replaced as a whole
```

- `POST teams/create` `{ name, tagline? | description?, color?: '#rrggbb', members?: (id | @handle)[], lead?: id }`
  → `{ ok, team: TeamView, teams: TeamView[] }`. The id comes from the name (`amazon-us`; `team`, `team-2` … for a
  name without Latin letters). Refused: no name, a name a team here has (any case), the dispatcher as a member, a
  `lead` not among `members`, a colour that is not hex. Members in another team move to it.
- `POST teams/update` `{ id, name?, tagline? | description?, color? }` → `{ ok, team, teams }`. On a hired template team
  an empty value gives the template's back; a team of your own keeps a name.
- `POST teams/delete` `{ id }` → `{ ok, unteamed: string[], teams }`: your own teams only; their bots stay, in no
  team, and its lead no longer leads.
- `POST teams/hire` also takes `name`, `tagline` / `description`, `color` (then the answer has `teamView`).
- `GET teams` (the template gallery) is unchanged; `POST settings` ignores `teams`.
- `save`, `bot_create` and `bot_update` take any team in `state.teams`, by id or name (yours, or the template's in
  either language). The roster bots read names a team by your name, with your description after it.
- Panel: **New bot → New team**; a team's header in the rail shows its colour and an edit button; the Teams page lists
  **Your teams** above the templates.

### Memory work outside a conversation

- Every model call `complete()` makes names a session (`sessionId`): a task's summary its task's session, the nightly
  consolidation `bots-dream-<botId>` and `bots-dream-team`, else the call's purpose. Providers that route by
  conversation (OpenCode Go's `x-opencode-session`) refuse a call without one.
