# Bots plugin — Host ⇄ Client contract

How the Host (`index.js` and `lib/`, running in Harness) and the Client (`client.js`, the panel) talk, what the bots'
tools do, and what the plugin stores. It describes the current version; what changed in each version is in
[CHANGELOG.md](CHANGELOG.md).

## Contents

- [Basics](#basics)
- [State, activity and catalog](#state-activity-and-catalog)
- [Bots](#bots)
- [Teams](#teams)
- [Skills](#skills)
- [Abilities and tool limits](#abilities-and-tool-limits)
- [Apps](#apps)
- [Models](#models)
- [Conversations: homes, topics and threads](#conversations-homes-topics-and-threads)
- [The timeline](#the-timeline)
- [Routing](#routing)
- [Tasks](#tasks)
- [Requests and the board](#requests-and-the-board)
- [Projects](#projects)
- [Tools](#tools)
- [Memory](#memory)
- [Usage and prices](#usage-and-prices)
- [Schedules](#schedules)
- [Settings](#settings)
- [Images](#images)
- [File references](#file-references)
- [Chat channels](#chat-channels)
- [GitHub Issues](#github-issues)
- [Storage](#storage)

## Basics

All routes live under `/__dsh_bots/`. GET returns JSON; state-changing calls are `POST` with
`content-type: application/json` and return `{ ok: true, ... }` or `{ ok: false, reason }`. A body may be up to 4 MB
(`images`: 40 MB). An unknown path answers `no such route`.

Words: the panel says **task**, **request** and **thread**; the code, routes, tools and files say **ticket**, **need**
and **discussion** (a thread forked from a conversation) or **Thread** (where a message came from and replies go, see
[Thread keys](#thread-keys)). A **run** is everything one Session does from one input until it is idle again; the
usage files and `TaskView` call runs `task`.

Each bot has a **home**: its own Harness Session (`Bot.sessionId`). One bot is the **dispatcher** (`role: 'primary'`):
the front desk that hands work out. With at least one teammate it is in **router** mode: it routes work and does none
itself ([Abilities and tool limits](#abilities-and-tool-limits)).

## State, activity and catalog

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `state` | – | `State` |
| GET | `activity` | – | `{ ok, at, bots: { [botId]: { status, activity?, avatarPending? } }, taskActivity }`: the live part of `state`, cheap to poll; the panel polls it every 1.5 s while anything runs |
| GET | `catalog` | – | `Catalog` |
| GET | `unfurl` | `?url=` | a link preview: `{ ok: true, kind: 'youtube' \| 'x' \| 'x-profile' \| 'page' \| 'image', url, … }` or `{ ok: false, url, reason }`. YouTube: the video id with oEmbed's title and channel; X posts and profiles through the public fxtwitter API; anything else: the page's OpenGraph / Twitter-card meta, `<title>` and icon. Pages are fetched only from public addresses (no loopback, LAN or link-local, checked on every redirect), with a size and time cap; results are cached in memory |

```ts
State = {
  bots: (Bot & {
    status?: 'idle' | 'running' | 'offline',   // live, from the agent registry
    activity?: Activity,                        // its home Session runs now
    avatarPending?: true,                       // a picture is being drawn for it
    appIssues: { [appId]: string },             // why an app cannot start (a required key is empty, say)
    channels: { [appId]: ChannelView },         // see Chat channels
    topic: { startedAt, lastActiveAt, tasks, context /* prompt tokens of the last call */ } | null,
    usageToday: number,                         // tokens today
    memoryNotes: number,
    tickets: { working, question, stalled, queued },   // counts of unarchived tasks
    asking: number,                             // questions waiting in its home
  })[],
  primaryId: string,                            // the dispatcher
  sessionMap: { [sessionId]: botId },           // homes and unarchived task Sessions
  ticketMap: { [sessionId]: ticketId },         // unarchived task Sessions
  messageCount: number,
  version: number,                              // the store's revision
  botsVersion: string,                          // the Bots version this Harness process loaded
  rotatedAt: number,                            // ms of the latest time Bots archived a conversation (a new topic, an idle thread); 0 since start
  limits: { skills: 200, skillsOn: 50 },
  teamNotes: number,
  dispatcher: 'router',
  routerActive: boolean,                        // router mode in effect now (the dispatcher has a teammate)
  routerNoticePending: boolean,
  needs: { waiting: number, working: number },  // requests waiting for the person (failed included) and under way
  oldLeads: { id, name, handle, team }[],       // see Teams: changes made at start
  leadOffers: LeadOffer[],
  teams: TeamView[],                            // hired template teams, then your own
  attention: TicketRow[],                       // tasks that need a person (question, failed, stalled, waiting on a question or approval), newest change first, ≤ 50
  asks: Ask[],                                  // see Tasks: questions and approvals
  taskActivity: { [ticketId]: Activity & { botId, title } },   // open tasks whose Session runs now
  display: { botMessages: 'line' | 'short' | 'full' },
  at: number,                                   // the Host's clock (ms), to time what runs
}
```

The panel shows a banner when `botsVersion` differs from its own version (Harness must be restarted), and selects
itself again when Harness closes it within 3 s of `rotatedAt` (Harness closes the active panel when the Session
behind it is archived).

`Activity` is what a Session does right now, while a turn runs: `{ kind: 'thinking' | 'tool' | 'writing', tool?,
detail?, startedAt, stepAt, steps }`. `tool` is the running tool's name; `detail` a summary of what it works on, ≤ 80
characters, only for tools the Host knows: a shell command's first line (`bash`, `pwsh`), a file's name (`read`,
`edit`, `write`), the search words (`web_search`, `…_search`, `grep`), a page's host and path (`web_fetch`), the
@handle work is handed to (`bot_send_message` with `to`; `#<id>` with `ticket`; none for a report), a skill's name.
Channel tokens and anything shaped or named like a key, token or password are replaced with `<redacted>`; tool
results are never read. `startedAt`: the turn's start; `stepAt`: the current activity's; `steps`: model calls so far
in the turn. The panel words it from `tool`, `detail` and its own dictionary.

```ts
Catalog = {
  templates: AppEntry[], categories: { id, en, zh }[],          // see Apps
  abilities: Ability[],                                         // see Abilities and tool limits
  skillSources: { id, repo, path, name, description }[],        // [{id: 'anthropics', repo: 'anthropics/skills', path: 'skills', …}]
  magpie: { root } | null,                                      // Magpie's skill library on this machine
  imageGen: boolean,                                            // the Images plugin's generate_image is available
  tools: { name, description }[],                               // every tool a conversation has before Bots limits it
  models: ModelRow[], defaultModel: { provider, model } | null, // see Models
  skills: { name, description }[],                              // installed Harness skills
  ocu: { installed: boolean, path },                            // Open Computer Use
  mcp: boolean,                                                 // Harness has an MCP client
  routerDeny: string[],                                         // what router mode denies the dispatcher's home
  teamDeny: string[],                                           // denied to the dispatcher while the team has more than one bot
  zone: string,                                                 // the machine's IANA time zone
}
```

## Bots

```ts
Bot = {
  id: string,                   // 'bot-…'
  name: string,                 // display name, any language
  handle: string,               // lowercase [a-z0-9-], ≤ 32, unique; @handle in messages
  role: 'primary' | 'bot',      // exactly one primary: the dispatcher
  avatar: Avatar,
  bio: string,                  // ≤ 300; one line shown on cards and to other bots
  persona: string,              // ≤ 20 000; system-prompt persona prose
  skills: Skill[],
  apps: App[],
  tools: { deny: string[], routerAllow?: string[] },   // see Abilities and tool limits
  model: { provider, model, reasoningEffort? } | null, // null = Harness's default
  sessionId: string | null,     // the bot's home Session
  team?: string,                // a team id (a hired template's, or one of your own)
  lead?: true,                  // leads its team; only with `team`, never the dispatcher, one per team
  createdAt: number, updatedAt: number,
  createdBy: 'user' | string,   // 'user' or the creating bot's id
}
```

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `save` | `{ bot: Partial<Bot> }` (no id = create; only the fields given change) | `{ ok, bot }` |
| POST | `delete` | `{ id }` | `{ ok }`; the dispatcher cannot be deleted |
| POST | `primary` | `{ id }` | `{ ok }`: make this bot the dispatcher (it stops leading a team) |
| POST | `open` | `{ id }` | `{ ok, sessionId }`: make sure the bot's home exists |
| POST | `send` | `{ to, text, replyTo?, images?, files? }` | `{ ok, sessionId, message? }`: the person's message to a bot, see [The panel chat](#the-panel-chat-and-threads) |

`save` takes `team` (a team in `state.teams`, by id or name; `''` for none; never for the dispatcher: `the dispatcher
belongs to no team`) and `lead` (true/false, for a bot of a team). A bot whose `team` changes keeps `lead` only when
the same save sets `lead: true`, so a lead that moves does not take the lead of its new team. A save whose `tools`
leaves `routerAllow` out keeps the stored list. A stored secret reads as `'••••••••'` in every answer; saving the mask
keeps the stored value.

`delete` stops and archives the bot's tasks and archives its home and threads, and stops every open task it asked for
(from its home or its tasks), which stays unarchived with `error: '@<handle>, who asked for it, was removed'`.

### Avatars

```ts
Avatar = { kind: 'initials', text?: string /* ≤ 2 characters, overrides the derived ones */, color }
       | { kind: 'image', url /* /__dsh_bots/avatar/<botId>?v=<n> */, color, source?: 'ai' }
```
With no `text`, the client derives the letters from the name: the first letters of the first two words ("Data Scout"
→ DS, "Atlas" → AT, "DataBot" → DB), or the pinyin initials of the first two Han characters ("研究员" → YJ, via
`Intl.Collator('zh-Hans-u-co-pinyin')` against the bounds `阿八嚓哒妸发旮哈丌咔垃妈拏噢妑七呥仨他屲夕丫帀` / letters
`ABCDEFGHJKLMNOPQRSTWXYZ`; the Host has the same `initialsOf` in `lib/store.mjs`). Old `{ kind: 'emoji' }` rows read
as initials.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `avatar` | `{ id, dataUrl }` (PNG, JPEG, WebP or GIF, ≤ 2 MB) | `{ ok, bot }` |
| GET | `avatar/<id>` | – | the image bytes |
| POST | `avatar/generate` | `{ id, style? }` | `{ ok, bot }`: a picture drawn with the Images plugin (`generate_image`); takes 10–90 s |
| POST | `avatar/clear` | `{ id }` | `{ ok, bot }`: back to initials |

The tools manage avatars too: `bot_create` and `bot_update` take `avatar_prompt` (a picture drawn by the Images plugin
from that description; without the plugin the result says so at once and the rest of the change still applies) and
`avatar_file` (an absolute path to a PNG, JPEG, WebP or GIF of at most 2 MB); `bot_update` also takes `avatar_clear:
true`. Called from a bot's home or task Session (or a helper of one), a drawing runs in the background: the call
returns at once, and when the drawing ends that conversation gets one note, steered (an idle home starts a turn;
several notes arriving together are one step), with the message id `bots:avatar:<job>` and source `{ kind:
'agent-message', form: 'relay' }`: `[Avatar ready] The new avatar of @x (Name) is ready…`, `[Avatar failed] The
picture for @x could not be drawn: <reason>. Its avatar is unchanged.`, or `[Avatar dropped] …` when another
conversation or the panel changed that avatar meanwhile. A home's turn takes the note like a report: the chats of the
turn that asked are its Threads, so the answer to the person goes there. A task Session gets it like any message for
its task (not after the task ended). Only the latest drawing asked for a bot counts: a newer one, a picture file,
`avatar_clear`, new letters or colour, a panel upload or clear replaces it (one replaced from the same conversation
sends nothing). Drawings are kept in memory only: a restart drops them without a note. From a conversation of no bot,
and through `avatar/generate`, the call waits for the picture; while any drawing runs, `state.bots[].avatarPending` is
`true`.

## Teams

A team is a group of bots under the one dispatcher. Teams come from four templates, or are your own. Every template
team has a **lead**, listed first: the dispatcher hands the team's work to it, and it plans, brings in its teammates
and answers once.

### Templates and hiring

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `teams` | – | `TeamTemplate[]`, the template gallery |
| POST | `teams/hire` | `{ id, lang: 'zh' \| 'en', name?, tagline? \| description?, color? }` | `{ ok, team, bots: Bot[], dispatcherId, kickoff: string, skipped: { bot, kind: 'skill' \| 'app' \| 'schedule', name, reason? }[], moved, teamView? }` (10–30 s: skills are imported from GitHub). `bots`: the members, after the dispatcher when the hire made one; `teamView` when a name, tagline or colour was given |

```ts
TeamTemplate = { id, name: {en, zh}, tagline: {en, zh}, description: {en, zh}, color, kickoff: {en, zh}, lead?: string,
  desk: { when, title: {en, zh} }[],   // scheduled tasks the hire gives the dispatcher
  bots: { key, handle, name: {en, zh}, color, bio: {en, zh},
          skills: { name, source: 'dsh' | 'import', repo?, available }[], apps: { id, available }[],
          tasks: { when, title: {en, zh} }[] }[] }   // the lead first
```
Templates: `opc` 一人公司 (lead `ops`, Compass: the week's plan `plan.md`, the inbox sweep, weekly numbers and market
pulse; the dispatcher's desk keeps the morning brief and weekly review), `dev` 研发小队 (lead `builder`), `content`
内容工作室 (lead `writer`, Quill), `research` 研究台 (lead `writer`, Memo). Hiring makes the dispatcher (Atlas) when
there is none and gives it the team's `desk` tasks unless it has one by that title; it sets `lead` on the template's
lead bot and `team` on each member. A member hired again gets no second routine of a title it has. When the dispatcher
existed before, its scheduled tasks whose title and prompt are still one of the lead's tasks in either language
(`deskTasksOfLead` in `lib/team-migration.mjs`) are deleted, but only those whose twin the lead now has (`moved`), so a
routine that could not be made on the lead stays on the dispatcher; an edited one stays. After hiring, the client
offers to send `kickoff` to the dispatcher (`send { to: dispatcherId, text: kickoff }`).

### Your own teams

```ts
TeamView = { id, name: {en, zh}, tagline: {en, zh}, color, template?: string, custom?: true, renamed?: true,
             members: string[] /* lead first */, lead: string | null }
```

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `teams/create` | `{ name, tagline? \| description?, color?: '#rrggbb', members?: (id \| @handle)[], lead?: id }` | `{ ok, team: TeamView, teams: TeamView[] }`. The id comes from the name (`amazon-us`; `team`, `team-2` … for a name without Latin letters). Refused: no name, a name a team here has (any case), the dispatcher as a member, a `lead` not among `members`, a colour that is not hex. Members in another team move to it |
| POST | `teams/update` | `{ id, name?, tagline? \| description?, color? }` | `{ ok, team, teams }`. On a hired template team an empty value gives the template's back; a team of your own keeps a name |
| POST | `teams/delete` | `{ id }` | `{ ok, unteamed: string[], teams }`: your own teams only; their bots stay, in no team, and its lead no longer leads |

Names, taglines and colours live in `settings.teams` (`{ [id]: { name?, tagline?, color?, custom?: true, at? } }`,
replaced as a whole; `POST settings` ignores it). `save`, `bot_create` and `bot_update` take any team in `state.teams`,
by id or by name (yours, or the template's in either language; `teamArg` checks it). The roster the bots read names a team by your name,
with your description after it. A bot's `team` is checked when it changes: a team of the templates one of whose
non-dispatcher bots belongs to it, or one of your own.

### Leads

In the panel a lead is tagged **Lead** in the rail and on the team templates; **Team** (`data-dsh-bots-new-team`,
`data-dsh-bots-team-select`) in **New bot** and on a non-dispatcher's Profile offers **No team** and the teams here,
and the Profile's **Leads …** switch follows the team chosen and is off after a move.

- `POST save` and `bot_update` take `lead`; saving one clears the others of that team. Refused for a bot of no team
  (`@x is part of no team; only a team has a lead`) and for the dispatcher. `primary` clears it on the new dispatcher.
- **The dispatcher** (router home): `bot_send_message` with `to` a member of a team that has a lead, not the lead, is
  refused (`@tester is on Software squad, which @builder leads: hand the team's work to @builder, …`) unless a message
  of the person's in this turn names that bot: its `@handle`, or the first word of its name (3+ ASCII characters), as a
  word of its own, in any case (`namesBot` in `lib/teams.mjs`). Adding to an open task of a member (`ticket`), a card
  handed to a member on the board, and other bots' messages are not checked.
- **Prompts**: the roster writes a led team as `- Software squad, led by @builder:` and tags the lead `(lead)`; a router
  persona reads that such a team takes its work through its lead. The lead reads `## You lead Software squad` (its
  teammates; plan first and check a bigger plan with the person; hand parts out as sub-tasks; answer once; another
  team's work goes to its lead). A member reads that the team's work comes to it from the lead. The rail
  (`groupByTeam`) and the roster (`rosterLines`) list a team's lead first.

### Changes made at start

Teams hired by older versions are brought up to date when the plugin starts. Only what still reads exactly as it was
hired changes; a persona, bio or scheduled task you edited stays as it is.

- **One dispatcher** (`planTeamMigration`): a lead that is your dispatcher (Atlas, Lead, Editor or Desk) keeps its name
  and becomes the front desk (persona and bio the dispatcher's, the skills of its lead role removed, an app of that role
  turned off with its keys kept); members get their current persona and bio; a team's routine moves to the dispatcher at
  the times it had (one it has by that name is not added twice), and moves on to the lead when the lead joins. A lead
  that is not your dispatcher is listed in `state.oldLeads` until `lead-notice/dismiss` (the panel offers to remove it
  with `delete` first, or keeps it).
- **Leads** (`planLeadMigration`, once, `settings.teamLeads: 'given'`): a led team none of whose bots leads it gets the
  bot with its lead's handle; a persona, bio or routine that still reads as an older version hired it
  (`lib/teams-0.14.mjs`) takes its current text. Names that still read as hired change (`lib/teams-0.15.mjs`, at every
  start): `Quill 写手` → `Quill 主编`, `Memo 撰稿人` → `Memo 主笔`.
- **Lead offers**: a template whose lead is a bot teams hired earlier lack (`ADDED_LEADS = ['opc']` in `lib/teams.mjs`)
  is offered when hired (a non-dispatcher bot with that `team`), none of its bots leads it or has the lead's handle,
  and it was not dismissed:
  ```ts
  LeadOffer = { team, name, lead: { key, handle, name, bio, color, tasks: {en, zh}[] } }
  ```
  `POST teams/add-lead { team, lang }` → `{ ok, team, bots: [the lead], dispatcherId, kickoff, skipped, moved }` (that
  member alone, `lead: true`, its scheduled tasks; no desk tasks; refused with `… has its lead already, or was not
  hired`). `POST teams/add-lead/dismiss { team }` → `{ ok, leadOffers }` (`settings.leadOffers[team] = 'dismissed'`).
- **Router notice**: a team that had bots before tasks existed gets `settings.routerNotice: 'pending'` once;
  `POST router-notice/dismiss {}` → `{ ok: true, routerNoticePending: false }`. `POST lead-notice/dismiss {}` →
  `{ ok: true, oldLeads: [] }`. `migrateTeams()` answers `{ …the one-dispatcher plan, leads: { bots, edits } }`.

## Skills

```ts
Skill = { id, name, source: 'own' | 'dsh' | 'import', description, content, enabled, dir?, origin?, linked?: true, from?: 'magpie' }
```
- `dsh`: an installed Harness skill referenced by name (content not stored; it stays up to date). Add one with `save`
  and `{ name, source: 'dsh', enabled: true }` in `skills`.
- `import`: copied from GitHub with its files (`origin`: the GitHub URL), or linked from a local folder (`linked`,
  `dir` = the folder; nothing is copied; `from: 'magpie'` for a folder in Magpie's library).
- `own`: written by hand or by the bot itself.

A bot keeps at most 200 skills, 50 of them on at once; past that, added skills are switched off. Names are unique
within a bot.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `skills/library` | – | `{ skills: { name, description, source }[] /* installed Harness skills */, sources: SKILL_SOURCES }` |
| POST | `skills/github` | `{ repo }` (`owner/repo[/path]` or a GitHub URL) | `{ ok, owner, repo, ref, skills: { name, description, path, files }[] }` |
| GET | `skills/local` | – | `{ places: { path, label, magpie?: true }[] }`: skill folders of other agents found on this machine, Magpie's library first |
| POST | `skills/local` | `{ path }` (a skill folder or a folder of them; `~` allowed) | `{ ok, root, skills: { name, description, path, files }[], truncated }` |
| GET | `skills/magpie` | – | `{ ok, root, skills: { name, description, path, files, agents: string[] /* Magpie's agent ids it gives the skill to, from its library.json */ }[], truncated }`, or `{ ok: false, reason }` with no library |
| POST | `skills/import` | `{ botId, items: ({ repo, ref?, path } \| { url } \| { local })[] }` | `{ ok, bot, added: string[], updated: string[] /* same name, same origin: replaced in place */, off: string[] /* added switched off */, skipped: { name, reason: 'exists' \| 'full' }[], failed }` |
| POST | `skills/write` | `{ botId, text }` | `{ ok, sessionId }`: asks the bot to write the skill itself (with skill-creator) and save it |

`catalog.magpie` is Magpie's skill library, `<its files>/library/skills`, looked for in `~/.config/magpie` (where its
app keeps its files) and then `$XDG_CONFIG_HOME/magpie` (its command line's). A Magpie skill is imported as
`{ local: path }`.

## Abilities and tool limits

```ts
Ability = { id, name: {en, zh}, description: {en, zh}, tools: string[], available: string[], risky? }
```
Abilities group Harness's built-in tools: `web`, `files`, `code`, `office`, `images`, `delegate` (sub-agents and
workflows), `schedule`, `ask`, `deliver`, `plugins`. An ability is off when all its `available` tools are in
`bot.tools.deny`; toggling one writes the deny list and keeps unrelated denies. The raw tool list is an "Advanced"
disclosure.

**Router mode** (the dispatcher with at least one teammate) denies the dispatcher's home `catalog.routerDeny`
(`ROUTER_DENY` in `lib/prompt.mjs`): the `code` ability (`bash`, `job_list`, `job_output`, `job_kill`,
`load_workspace_dependencies`), `write`, `edit`, the `delegate`, `images`, `office`, `web` and `ask` abilities, `pwsh`,
the terminals (`terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`,
`terminal_list`), `apply_patch` and `str_replace_editor`. It keeps `read`, `read_image`, `glob`, `grep` and `skill`.
`Bot.tools.routerAllow` lists tools it keeps anyway (**Turn back on** under its Abilities). A router home also gets a
`tools.guard` that refuses `bash` and `pwsh` running `sleep`, or in the foreground without a `timeoutMs` of at most 30 s
(left out, it is Harness's 120 s; `run_in_background` passes), and `job_output` waits over 5 s (or without
`timeout_ms`). A task Session of the dispatcher is an ordinary worker: none of this applies there.

**A team of more than one bot**: the dispatcher's conversations (its home and any task of its own) are denied the
sub-agent and workflow tools (`subagent`, `wait_agent`, `workflow`, …; `catalog.teamDeny`, which the panel applies to
the dispatcher only); the other bots keep them.

## Apps

```ts
App = { id, template, name, serverName /* [A-Za-z0-9_-]{1,32}; tools appear as mcp__<serverName>__* */, enabled,
        values: { [fieldKey]: string }, config: { command?, args?, env?, url?, headers? } }
AppEntry = { id, name: {en, zh}, description: {en, zh}, category, icon /* 1–3 letters or a CJK character */, color,
  transport: 'stdio' | 'streamable-http', serverName, command?, args?, url?, runtime?: 'node' | 'uv' | 'binary',
  homepage, keyUrl?, region?: 'cn', featured?: boolean, custom?: boolean, fields?: AppField[],
  kind?: 'channel', channel?: 'telegram' | 'discord' | 'feishu' | 'slack' | 'github', logo?: string }
AppField = { key, label: {en, zh}, kind: 'secret' | 'text' | 'path', required?, placeholder?, default?, multi? /* one per line */, help?: {en, zh} }
```
Catalog apps keep their settings in `values` (keys from the entry's `fields`); custom apps (`mcp-stdio`, `mcp-http`)
keep theirs in `config`. Categories, by business use: `business` 销售与收款, `work` 团队与办公, `dev` 研发与交付,
`research` 调研与内容, `computer`, `data`, `life`, `custom`. What Harness already does itself (files, fetch, time, …)
is not in the catalog. A `channel` entry is a [chat channel](#chat-channels), not an MCP server. `state.bots[].appIssues`
says why an app cannot start.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `apps/external` | – | `{ items: { from, name, serverName, template, config /* values masked */ }[] }`: MCP servers found in the configs of Codex, Claude Code, Claude Desktop, Cursor, Windsurf, Gemini and opencode |
| POST | `apps/import` | `{ botId, names: ['<from>/<name>'] }` | `{ ok, bot, added }` |
| POST | `ocu/install` | `{}` | installs Open Computer Use (at most 5 minutes; `an install is already running` while one runs); bots already using the app start it again. `catalog.ocu` says whether it is installed and where |

## Models

```ts
Bot.model = { provider, model, reasoningEffort? } | null   // reasoningEffort: one of the model's efforts; null: Harness's default
ModelRow = { provider, model, label, group /* provider display name */, name, source?: 'custom' | 'login',
             efforts?: { id, name }[], defaultEffort?, context? /* tokens */ }
Endpoint = { route /* 'bots-<slug>' */, name, api: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai',
             baseURL, models: { id, name?, contextWindow? }[], keyConfigured: boolean }
Login = { id: 'codex' | 'claude-code' | 'gemini-cli' | 'copilot', name, product, found, supported, account?, plan?,
          connected?, sync?, reason?: 'terms' | 'harness' | 'signin' }
```

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `models/sources` | – | `{ custom: Endpoint[], logins: Login[], apis: string[], writable }` |
| POST | `models/custom/test` | `{ api, baseURL, key?, route? }` (no key + route = the stored key) | `{ ok, models: { id, name? }[] }` |
| POST | `models/custom/save` | `{ route?, name, api, baseURL, key?, models: (string \| { id, contextWindow? })[] }` | `{ ok, route }` |
| POST | `models/custom/delete` | `{ route }` | `{ ok }`; bots on it go back to `model: null` |
| POST | `models/login/connect` | `{ id: 'codex' }` | `{ ok, route: 'openai-codex' }` |
| POST | `models/login/disconnect` | `{ id: 'codex' }` | `{ ok }` |

An endpoint is a route in the settings of Harness's `llm-pi-ai` adapter (`providers.<route>`, `apiKeyEnv:
BOTS_<SLUG>_API_KEY`), its key set through the credential store. The Codex login is the grant record
`llm-pi-ai/openai-codex` (`{ type: 'oauth', access, refresh, expires, accountId }`) plus a `providers.openai-codex`
route; while in use it is compared with `~/.codex/auth.json` every 5 minutes and on every
`credentials/record-updated`, and the side holding the older refresh token takes the other's tokens.

Every model call the plugin makes outside a conversation (`complete()`: a task's memory summary, the nightly
consolidation) names a session: a task's summary its task's session, consolidation `bots-dream-<botId>` and
`bots-dream-team`, else the call's purpose. Providers that route by conversation (OpenCode Go's `x-opencode-session`)
refuse a call without one.

## Conversations: homes, topics and threads

### Topics

A bot's home is a **topic**: when it has been idle `settings.topics.idleHours`, or its context passes
`maxContextK`, or the person asks, the bot starts a new Session and the old one is archived (its schedules are
retargeted first, `schedule.edit` patch `target`). A timeline entry `kind: 'topic'` (`from: 'system'`, `text`:
`'manual' | 'idle' | 'context'`) marks it.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `topic/new` | `{ id }` | `{ ok, sessionId }`; refused while the bot runs |

`send` with `/new`, `/clear`, `/reset`, `/新话题` or `/新对话` first starts a new topic; text after the command goes
there. The same commands work from chat apps. A task Session is no topic: it never rotates, and its calls do not count toward the home's context.

### The panel chat and threads

The panel chat lists what was said in order, like a chat app. A reply to a message goes into that message's thread
and shows in the chat quoting what it answers. A thread on a task's own message goes to that task; any other thread
is a **discussion**: the bot's conversation forked with Harness's `sessionController.fork({ sessionId, atSeq })` at the
replied message, so it sees that message and what came before, and nothing the main chat said after it.

| Method | Path | Body / query | Answer |
|---|---|---|---|
| POST | `send` | `{ to, text, replyTo?, images?, files? }` | `{ ok, sessionId, message }`: `message` is the logged message (`topic`: the root id when it went into a thread; `pending`); none for `/new` alone. `replyTo`: a main-chat message opens (or joins) its thread; a message in a thread keeps it in that thread, quoted. Refused: `/new` in a thread (`a thread has no new topic: send /new in the main chat`), a message of another bot's chat (`that message is not in this chat`). With `images` or `files` ([File references](#file-references)), `text` may be empty |
| GET | `messages` | `?bot=<id>&limit=200` | `{ items: Message[], threads: { [rootId]: ThreadSummary } }`: the chat as it was said, oldest first (messages whose `chat` is the bot, and those without `chat` from or to it), the messages of threads among the rest with their `quote` (the window as it is: a root older than it is not brought along); `threads` for each item that has a thread |
| GET | `messages` | `?bot=<id>&topic=<rootId>&limit=500` | `{ items: [root, ...replies], threads }` for one thread |
| GET | `messages` | `?limit=200` | every message, oldest first |
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

A top-level panel message goes to the bot's home, logged before it is handed over (delivery id `bots:panel:<id>`, so
it is logged once; ids are `p` + 8 lowercase letters or digits), without a thread id. A router home gets it with a
header `[Panel]`, then `Open needs: …` ([Requests](#requests-and-the-board)) and `Open tasks: …` (its tasks still open
or ended within a day, latest change first, ≤ 8); another home takes it as a turn of its own, with no header. When the
panel's threads had messages since the home last heard (`discussions.json` `told[botId]`, not before the current
topic started), the message comes after this note (at most `NEWS_MESSAGES` = 16, the latest; each clipped to 300 characters; chat-app
threads, bot-to-bot messages and system lines left out):
```
[Threads] Since your last message here, the user replied to messages of this chat in threads (each its own conversation, which answered there). So you know what was said; nothing to answer:
- On your message: "约 39.5 万。要不要我写个小脚本？"
  The user: "什么情况下你会这么做？"
  You: "当你会反复问同一个数字的时候。"
```
The root is named `your message`, `the user's message` or `@handle's message`; a teammate's line `@handle`.

A reply in a thread goes:
- **to a task** when the root is that task's own message (`root.ticket`, live: not archived, not stopped by a person):
  the task is subscribed to the thread and its `showIn` is set to the thread's key, where its later `done` /
  `question` / `blocked` reports are shown (`bots:panel:<id>:<ticketId>`, `[Panel]\nIn reply to …` when it answers a
  message other than the root). The note `[follow_up] …` is injected into whoever asked for the task: the home, or the
  discussion that opened it.
- **to the thread's discussion** otherwise, forked the first time:
  1. at the replied message's anchor (where it sat in its Session, noted as events arrive; for a person's message, the
     end of the turn that took it, so the answer it got is included);
  2. else at its place found in the Session's log by time (`seqByTime`: a bot's message at the last event at most
     1.5 s after it was logged; a person's at its own `user/message` event — the first one from 50 ms before it was
     logged on — then the end of that turn), in the Session the message was said in (its `sid`, the panel Thread's
     Session, the bot's own task, or the bot's home);
  3. else at the latest finished turn of the bot's home. Such a discussion, or one whose `atSeq` fork failed and was
     retried without it, is `exact: false`.

  The fork is given the bot (tools, persona, memory; a router home's fork stays a router) and its model (a fork starts
  on Harness's default), and titled `<bot> · <the start of the root>`. Its replies are logged in the thread; topic
  rotation, `topics.noteCall` and `noteTask` look only at the home. The first message of a discussion carries (claimed before the hand-over, so two
  first replies at once carry it once):
  ```
  [Thread] From here on this is a thread: the user replies to this message of @forge above: "…". Answer about it.
  What the main conversation said after that message is not visible here.
  ```
  With `exact: false`: `… this message of @forge: "…". Answer about it.` and `The conversation above may go on past
  that message; stay on that message.` A quote of another message of the thread adds `In reply to <who>: "…"`; later
  quotes get `[Panel]\nIn reply to <who>: "…"`.

In a discussion the person talks to its bot even after that bot opened tasks there: such tasks have the thread as
origin, report into it, and their relays and reminders reach the discussion (`requesterAgent`). Errors: `threads need
the Web profile (no session controller here)`; `this DeepSeek Harness cannot fork a conversation; update it to reply
in a thread`; `the conversation that message was said in is gone; send it as a new message instead`; the message is
then dropped from the chat (`hidden`). A discussion quiet for 24 h (`IDLE_ARCHIVE_MS`) is archived in Harness by the task upkeep; the next
reply takes it out of the archive (`workspaceRegistry.unarchiveSession`), or, when that fails, forks it again from
its own latest turn. Removing a bot archives and forgets its discussions; a model change applies to them too.

Chat apps' threads work the same way: see [Inbound messages](#inbound-messages).

**0.9 data**: 0.9 made every panel message a topic (`panel:<sessionId>:<rootId>`, the root having `topic === id`;
a message filed under another topic has `movedTo`). Such rows read as main-chat messages with a link to their thread
under the first one; a 0.9 topic with subscribed live tasks and no discussion still sends replies to its tasks.

## The timeline

`messages.jsonl` under the cache is the timeline every chat in the panel reads. It is append-only: a change to a logged
message is a later line `{ id, patch: true, ...fields }`, merged into it when the log is read and dropped when the
log is compacted.

```ts
Message = {
  id, from, to,                     // a bot id, 'user', 'system' or 'schedule'
  text, at,
  kind: 'user' | 'reply' | 'dm' | 'system' | 'topic',
  via?: 'telegram' | 'discord' | 'feishu' | 'slack' | 'github',   // typed in / sent to that chat app
  who?: string,                     // who wrote it there
  thread?: string,                  // its Thread: main chat 'panel:<sessionId>' or a chat key; in a thread, the thread's key
  chat?: string,                    // the bot whose panel chat shows it (set: only that chat shows it)
  topic?: string,                   // only on a message inside a thread: the thread's root id
  replyTo?: string,                 // a message in a thread that quotes one other than the root
  ticket?: string,                  // a task's report, or a message that went to that task
  status?: 'done' | 'blocked' | 'question' | 'stalled' | 'failed',
  added?: true,                     // a message added to a task opened earlier
  notSent?: true, choices?: string[],   // plain text of a turn with several places, sent to none of them
  error?: string,                   // a failed turn's notice
  need?: string,                    // the request (card) it started or belongs to
  images?: string[],                // image ids (Image[] in `GET messages`)
  files?: FileRef[],                // the files it references
  sid?: string,                     // the Session it was said in
  movedTo?: string, failed?: true, hidden?: true,
  // in `GET messages` only:
  quote?: { id, from, text /* ≤ 140 */, who?, via? },   // inside a thread: the person's message it replies to (else the root); a bot's: the person's latest of the thread before it
  pending?: true,                   // a panel message no model has taken yet (or waiting for a task to start or a worker slot)
  card?: { id, title, ref? },       // the card a message started
}
```

| kind | Fields | Entry |
|---|---|---|
| `user` | `chat`, `thread`, `topic?`, `replyTo?`, `ticket?`, `images?`, `files?` | a panel message, logged before it is handed over; `ticket`: a reply that went straight to that task |
| `user` | `thread`, `via`, `who` | a chat app's message into a bot's home |
| `user` | `via`, `who`, `thread`, `ticket` | a chat follow-up that went straight to a task |
| `user` | `ticket` | the person's answer to a question in the panel, `"<question>\n→ <answer>"` |
| `reply` | `chat`, `thread`, `topic?`, `via?` | a bot's answer; `via` when it went to a chat (with `bot_reply` too). Main chat: `{ from: bot, to: 'user', chat: bot, thread: 'panel:<sid>' }`; answers in a discussion carry the thread's `thread` and `topic` |
| `reply` | `chat` (the bot that asked), `ticket`, `status`, `thread`, `topic?`, `via?` | a task's `done` / `question` / `blocked` report shown to the person where the task came from (`from`: the task's bot) |
| `reply` | `notSent: true`, `choices` | plain text of a turn with several places that a chat of it still waits on: sent to none; `choices` are the turn's chat Thread keys |
| `reply` | `error`, `thread`, `via?` | a home or thread turn that answered a person's message, a report or a scheduled run and ended in an error once Harness's retries were spent (not an empty answer, not a stop): a notice in the bot's language, sent where its answer would have gone (the turn's one Thread, or each of its chats). `error` is the error's message, secrets scrubbed. It does not count as telling the person (reminders still come) |
| `dm` | `ticket`, `chat?`, `thread?`, `topic?` | a bot opened the task for `to` |
| `dm` | `ticket`, `added: true` | a message added to a task opened earlier (`from: 'user'`: the person, from the panel). The chat shows its own words marked as added; older entries have no `added`, so the chat also reads each later `dm` of a task as added |
| `dm` | `ticket`, `status: 'done' \| 'blocked' \| 'question'` | a task's report to its requester (`to`: the requesting bot); `progress` reports are not logged |
| `dm` | `ticket`, `status: 'stalled' \| 'failed'` | the watchdog marked the task stalled, or it failed after an error |
| `dm` | – | a message between two bots outside a task |
| `system` | – | a scheduled run (`from: 'schedule'`) or a notice |
| `topic` | `text` | a new topic started |

Entries written before 0.8 have no `thread`, `ticket` or `status`; the main timeline keeps them.

## Routing

### Thread keys

A **Thread** is where a message came from and where replies go: `kind:appKey:chatId[:rootId]`, with `appKey` =
`<botId>/<appId>` of the chat app; inside a part `%` and `:` are written `%25` and `%3A`. A panel conversation is
`panel:<sessionId>`; a thread of the panel chat `panel:<sessionId>:<rootId>`. The root is the connector's `threadId`:
Slack `thread_ts` (a top-level channel message: its own `ts`), Discord the thread channel or the root of the reply
chain, Feishu the root message of the reply chain or topic, Telegram the forum topic (`message_thread_id`), GitHub the
issue number. Without one, a Slack, Discord or Feishu group message is its own root (the bot answers under it); private
chats and Telegram groups without topics are the whole chat.

### Inbound messages

A chat message reaches a bot as text blocks: `Open needs: …` (to the router), `Cards named: …` (when it names cards),
the source line `[Telegram · Name] (thread <key>)` (plus the group name in a group; `source` overrides the label, `Lark`
for a Lark app), the text, then its chat context and images ([Chat channels](#chat-channels)); every block but the last
ends with a line break. Where it goes (`routeInbound` in `lib/threads.mjs`):

1. A leading `@handle` of another bot goes to that bot's home; the channel owner's own handle goes to its home.
2. Tasks subscribed to the message's Thread that are not archived and not stopped take it, steered into each task
   Session as a person's message (an ended task opens again), and the owner's home gets a `[follow_up]` note injected
   without waking it. On a whole-chat Thread (no `rootId`) only a task whose latest report is an unanswered `question`
   takes it, and only when it is the one such task: with two or more, the message goes on as if none had.
3. A message for the router that starts with a card's reference whose card has exactly one live task goes to that task
   ([Cards named](#cards-named)).
4. Otherwise a message in a Thread with a root goes to that Thread's discussion when there is one; when there is none,
   it forks one at the Thread's anchor (the home's latest exchange there: the message it took, its answer, the end of
   that turn) or at the anchor of the root message (`chat:<appKey>:<chatId>:<messageId>`, a message the bot took in or
   sent), if that Session is the bot's. The Thread's first message, one that arrives while the home is still on that
   Thread, and a message of a whole chat go home. The first message in a discussion gets `[Thread] From here on this is
   a thread: the user replies to an earlier message of the conversation above. …` before its source line.
5. Otherwise the owner's home (the router).

### Where replies go

Each turn of a home collects the Threads of its inputs (`createOrigins` in `lib/threads.mjs`): user messages, and the
origin Threads of the tasks a report, a `[Failed]` or `[Stalled]` note, or a `[Reminder]` is about. A task from no
Thread (a scheduled run with no chat, a turn that named none) counts as the home's own place: the panel (a
discussion's own Thread for a discussion). Then:

- one Thread (a chat Thread or a panel thread) and nothing else: plain replies go there;
- only the panel as a whole, or nothing: they stay in the panel;
- anything more (two chats, a chat and a panel thread, or one and the panel as a whole): plain text stays in the panel,
  and the bot sends each answer with `bot_reply`. A new task in such a turn must name its `thread` (one of the turn's,
  or `panel` for the panel as a whole), else it is refused with the choices. Plain text is marked `notSent` (with the
  turn's chat Thread keys as `choices`) while a chat of the turn has no answer; it is not shown once `bot_reply`
  answered every topic and chat of the turn, unless the panel as a whole was one of its inputs: then it is the panel's
  answer, shown as usual.

The set lives until the turn ends; as a guard against a turn end never seen, a session's whole set is dropped once its
latest input is 30 minutes old, unless its Session still runs. `bot_send_message { ticket }` from a home whose turn has
one other panel thread that is only a person's message (or the one `thread` names) files that message under the task's
thread (`movedTo`), and the turn's replies go there. A teammate's DM in a turn with no other input answers where the
last turn with a person's input did. A scheduled run of the owning bot reports to `paired[0]` privately when the
channel's `scheduleReplies` is on. A task Session's text reaches no chat.

### Deliveries

Deliveries the plugin makes with a key get the message id `bots:<key>`; one already pending, in the Session's stored
log or parked on its task is not delivered again (so a replay after a restart changes nothing). Router homes, task
Sessions and relayed reports use `agent.steer` (messages that arrive during a turn are taken together at its next
step); notes that should not wake use `agent.inject`; other homes take user messages and DMs with `followup`. A
Harness without `steer` gets `followup`; one without `inject` gets no such note: it is dropped, never turned into a
turn. A note (`[Shown]`, `[follow_up]`, `[Closed]`, …) for a conversation in the middle of a turn is held until the turn
ends, then injected, so it is never the newest input of a step.

Ids in use: `bots:panel:<id>` (a panel message), `bots:panel:<id>:<ticketId>` (one that went to a task),
`bots:chat:<appKey>:<chatId>:<messageId>`, `bots:dm:<uuid>`, `bots:report:<ticket>:<index>:<at>`,
`bots:failed:<ticket>:<at>`, `bots:stalled:<ticket>:<at>`, `bots:shown:<ticket>:<index>:<at>`,
`bots:followup:…`, `bots:ended:<ticket>:<at>`, `bots:remind:…`, `bots:board:<ticket>`, `bots:avatar:<job>`.

### The dispatcher's notes

What the dispatcher (or any bot that asked for a task) reads besides people's messages:

| Note | Wakes it | Says |
|---|---|---|
| `Report from @bot on task t… — status: …` | yes | a report it asked for (`report_to: 'me'`, or the report could not be shown), ≤ 600 characters with a pointer to the rest, the task card and the next step |
| `[Shown] @bot's report on task …` | no | the report went to the person as it is, where the task came from; it needs no reply, and the bot leaves the task out of its next answer, which goes to whoever wakes it |
| `[follow_up] …` | no | a person's follow-up went straight to the task |
| `[Failed]`, `[Stalled]` | yes | the task failed or stalled; decide what to do |
| `[Reminder] …` | yes | every task it waited for settled and it has said nothing since |
| `[Closed]`, `[Stopped]` | no | the person closed or stopped one of its tasks |
| `[Board] …` | no | the person handed a card to a teammate themselves |
| `[Threads] …` | – | what was said in the panel's threads, before the person's next message |

A `[Failed]`, `[Stalled]` or relayed report names the chat its task came from (`It came from <label>: what you say
about it goes there, so say nothing there about other tasks.`), or says it came from no chat and the answer stays in
the panel (`… If someone wrote from a chat in this turn too, answer them with bot_reply.`). A sub-task's notes name
neither: its requester is a task, which answers no one.

### Empty answers

Harness's pi-ai adapter turns an answer that stops with no content into `EMPTY_RESPONSE` (`model "…" returned a
completed response with no content`), retries it, then fails the turn. Every persona tells the bot to write only
`NO_REPLY` when nothing needs saying; a final text that is that marker alone (any case, in backticks or with a full
stop) is never logged as a reply, sent to a chat app or kept in a task's log. A task whose turn still fails with
`EMPTY_RESPONSE` is not failed or retried by the plugin (the watchdog still asks one that never reports), and a run
that ended so is not marked `error`.

## Tasks

A **task** (ticket) is work one bot hands another, done in a Harness Session of its own (`ticket-<id>`). Only bots
open tasks (`bot_send_message`), or the person from the board.

```ts
Ticket = {
  id: string,                          // 't' + 8 lowercase letters and digits
  title: string,                       // ≤ 120 characters; from the first line of `text` when not given
  text: string,                        // what was asked, ≤ 50 000 characters
  botId: string,                       // the bot doing it
  sessionId: string | null,            // 'ticket-<id>' once started
  requester: { kind: 'session' | 'user', sessionId?, botId?, ticketId? },  // ticketId: asked from that task (a sub-task)
  parentId?: string,
  origin: {
    threadKey?, via?, who?,            // via: 'telegram' | 'discord' | 'feishu' | 'slack' | 'github' | 'schedule'
    replyTo?,                          // the group message that asked; the answer there quotes it
    said?, context?, ids?,             // the chat message it was opened from (≤ 8000), the chat context read with it
                                       // (≤ 12 000) and { chat, message, root } ids; a sub-task inherits them
  },
  threads: string[],                   // Thread keys it is subscribed to (its origin's, when it has one)
  showIn?: string,                     // a thread opened on it, where its reports show instead of its origin
  relay?: true,                        // opened with report_to: 'me'
  projectId?: string, board?: true,    // a project's task; handed out by the person from the board
  images?: string[],                   // what its assignment carries, ≤ 10
  files?: FileRef[],                   // the files its assignment references, ≤ 10
  reports: { at, status: 'progress' | 'done' | 'blocked' | 'question', text }[],  // newest 200, each ≤ 20 000 characters
  createdAt, updatedAt, startedAt?,
  lastEventAt?,                        // latest event in its Session
  lastHumanAt?, lastRequesterAt?,      // latest message from a person / from the requester
  nudgedAt?, stalledAt?, remindedAt?,  // watchdog
  retries: number,                     // "continue"s sent after temporary errors in a row
  parked?: { key, content, source, at, human? }[],  // messages waiting for a worker slot, oldest first
  error?: string,
  ended?: { at, by: 'worker' | 'requester' | 'user' | 'system', outcome: 'done' | 'stopped' | 'failed' },
  archivedAt?,
}
Thread = { key, kind, appKey, chatId, rootId?, label?, tickets: string[] /* subscribed task ids */, lastAt }
```

A task's first message (`assignmentText` in `lib/cards.mjs`): `New task t… from <who>: <title>`, where it started,
the card it serves, up to 1500 characters of the assignment, `--- Where it came from ---` with the chat message and
context (≤ 4000 characters; `said` left out when the assignment repeats it), its images, and how to report; the files
it references follow in a block of their own ([File references](#file-references)). A project's
task's persona adds `## The project`.

### Stages and slots

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

At most `settings.tickets.maxWorking` task Sessions work at once. A started task's Session gets a message only while
the task holds a worker slot. A person's message (from the panel, a chat follow-up, or a `bot_ticket` `retry` or
`status` from a conversation of no bot) may take one slot over the limit; any other (a bot's, the watchdog's) waits in
`parked` while every slot is taken, and the task counts as `queued` until the messages go in, oldest first, as a slot
frees. Parked messages outlast a restart; the task ending drops them.

### Where a task works

A task's Session is made in its project's folder (`workspaceRegistry.create(dir, name)`, which returns the existing
workspace of that folder; `cwd` when Harness has no registry); a project whose folder is gone fails the start (`did not
start: the folder of project OPC, …, is gone; set another one on the board`). For a task without a project, the target
bot's handle picks an existing folder from the plugin config `bots.config.workdirs`; new homes use the same setting. Both fall
back to the shared `workdir` when the handle has no usable folder, as does a project with no folder.

### Reports

`bot_send_message { …, report_to?: 'thread' | 'me' }` on a new task. A task with an origin Thread that is no sub-task
and was not opened with `report_to: 'me'` answers the person itself: its `done`, `question` and `blocked` reports are
logged as replies in its panel thread (or the panel), or posted to its chat Thread through that chat's app (signed
`【Name】` when the worker is not the bot the chat belongs to; quoting the message that started it). The requester gets
a `[Shown]` note injected, which is no input of its turn. When the chat cannot be reached, and for every other task,
the report goes to the requester (`Report from …`, steered). Requester reminders skip tasks whose reports go to the
person. The worker's tool result says where it was shown.

A `done` report ends the task, except while a person's message to it waits unread (pending in its conversation, or
parked for a slot): the report is passed on as usual, the task stays open (`addReport(…, { keepOpen: true })`), and
the worker's tool result says the message comes next and to report again. A report from a task that has ended, or from
a sub-task whose parent has ended, is only recorded.

### Routes

```ts
TicketRow = { id, title, botId, stage, requester: { kind: 'bot', botId } | { kind: 'user' }, via?, board?: true,
  createdAt, updatedAt, lastReport?: { status, preview /* ≤ 200 characters */ },
  activity?: Activity /* while its Session runs */, asking?: true, askingApproval?: true }
TicketView = TicketRow & {
  text, parentId?, children: string[], requesterSessionId: string | null, origin,
  startedAt?, ended?, error?, archivedAt?, nudgedAt?, stalledAt?, retries? /* when not 0 */,
  reports: { at, status, text }[],
  threads: { key, kind, label }[],
  runs: { id, trigger, title, start, end, status, tokens, calls, cost }[],   // oldest first
  usage: { tokens, calls, cost },      // all calls made for the task, its memory summary included
  sessionId: string | null,
  running: boolean,                    // its Session is in a turn now
  need?: { id, title, ref? },
  images?: Image[],
  files?: FileRef[],
}
```

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `tickets` | `?bot=<id>&stage=<stage>[,<stage>…]&archived=0\|1&limit=50&offset=0` (limit 1–200) | `{ items: TicketRow[], next_offset: number \| null }`, latest change first |
| GET | `tickets/<id>` | – | `TicketView` |
| POST | `tickets/<id>/stop` | `{}` | `{ ok, …TicketView }`: ends it as stopped by the user and cancels its running turn |
| POST | `tickets/<id>/close` | `{}` | `{ ok, …TicketView }`: ends it as done and cancels its running turn |
| POST | `tickets/<id>/retry` | `{}` | `{ ok, …TicketView }`: opens it again and hands the assignment over afresh (also one the user stopped) |
| POST | `tickets/<id>/message` | `{ text, images?, files? }` | `{ ok, …TicketView }`: the person's message into its Session; an ended task opens again; a queued one gets it added to its assignment |
| GET | `threads/<key>` | key URI-encoded | `{ key, label, kind, tickets: TicketRow[], recent: { at, from, to, who?, text }[] }` (the last 10 timeline messages of that Thread, text ≤ 300 characters) |

An unknown id answers `{ ok: false, reason: 'no such task' }`; an archived task cannot be retried or messaged. A
task's requester hears of a stop or close by the user through an injected `[Stopped]` / `[Closed]` note.

### The watchdog and restarts

The 5-minute upkeep (`lib/watchdog.mjs`):
- a `working` task whose Session is idle, with no shell jobs, sub-agents or working/queued sub-tasks, and no event,
  report or message for `stallMinutes`: one status check (`nudgedAt`); still nothing `stallMinutes` after it:
  `stalledAt`, a `[Stalled]` note to the requester, and its slot is freed. A task waiting on a question or an approval
  is left alone;
- `agent/error` in a task Session: HTTP 408, 429 or 5xx, or a refused, reset or timed-out connection (not quota or
  billing errors), gets a "continue" after 15, 30 and 60 s (`retries`); then, or for any other error, the task ends as
  `failed` and the requester gets a `[Failed]` note. A completed turn resets `retries`;
- a requester Session that is idle, whose unarchived tasks have all settled (`done`, `failed`, `stopped`, `stalled`)
  and that said nothing since (a home: a timeline `reply` not marked `notSent` and no error notice; a task Session: a
  report): one `[Reminder]` (`remindedAt`), at least a minute after the last one settled. A task Session whose task has
  ended gets none;
- tasks ended `archiveHours` ago: their Session is archived and `archivedAt` set; quiet discussions are archived too.

At start, only tasks that were working take their slots again. 3 s after the plugin starts, one whose Session had to
be made anew gets a `[Recovery]` note and its assignment; one whose stored log holds no message gets its assignment
again; one whose Session was mid-turn, or holds input it never took, gets the note. The note's id names the latest turn
that did not end cleanly, so a second restart before it is read sends nothing new, and a recovery turn cut off again
gets a note of its own. Then queued tasks start, and parked messages are handed over, while slots are free.

### Questions and approvals

Bots answers Harness's `user-questions/request` (`ask_user_question`) and `approval/request` (a write outside the
workspace, a command outside the sandbox) for a bot's home Session and for task Sessions, ahead of Harness's own
window: the request settles with whichever answers first, the panel or the window; the other is withdrawn. With no
window connected (`NO_PROVIDER`) a question waits for the panel. Questions with an `approval` or `plan-review` intent
are recorded but only answered in the conversation. A timed question that ran out stays answerable (`continued`) and
is answered through `userQuestions.answer`. For approvals the tools pipeline asks `ctx.approval.request({ agent,
toolName, callId?, reason?, displayReason?, signal })`, whose answerers are `approval/request` waterfall listeners: Bots
listens first (`prepend`), other Sessions pass by untouched, and the forwarded request gets a signal that aborts once
the panel decided. An abort of the call settles it `cancelled`; a window that fails, `unavailable`.
Everything is kept in memory only.

```ts
Ask = { id, botId, sessionId, ticketId?, at, native?: true, continued?: true,
        questions: { id, question, header?, detail?, options?: { label, description? }[], multiSelect? }[],
        approval?: { tool, callId?, display?: { [lang]: text } /* from displayReason */ } }   // oldest first in state.asks
```
`native` questions carry only `{ id, question }`. An approval's one question is `{ id: callId | 'approval', question }`,
the question being `display.en`, else `reason`, else `Run the tool "<tool>"`. `state.bots[].asking` counts those
waiting in a bot's home; task rows and views carry `asking: true` (and `askingApproval: true`) meanwhile, and
`attention` lists those tasks.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `asks/<id>/answer` | a question: `{ answers: { id, selected: string[], custom? }[] }`; an approval: `{ outcome: 'allowed-once' \| 'rejected' }` | `{ ok: true }`, or `{ ok: false, reason }`: unknown or already answered, a `native` question, or an invalid answer (every question needs exactly one item, labels must be offered ones, a single choice takes one option or `custom`, none may be empty) |

A panel answer to a question is logged in the timeline as a user message, `"<question>\n→ <answer>"`, with `ticket`
for a task; an approval is not logged. A chat the turn came from gets one notice per question, or that the bot waits
for approval, in the bot's language. The bot that asked for the task hears what it waits for: `bot_ticket` `status`
answers with it instead of sending a status request, `bot_send_message` adding to the task says so, and `bot_recall`
cards carry `waiting_for: "the person's approval in its conversation: <question>"` (a question: `"the person's answer
to its question: …"`).

## Requests and the board

The panel says **request** and shows them as cards on a board; the code, routes, tools and files say **need**. A need
is one thing the person asked for, above the tasks that do it.

```ts
Need = {
  id: string,                    // n + 8 [a-z0-9]
  title: string,                 // ≤ 80 characters: the request restated for the person, in their language
  auto?: true,                   // titled with the person's words: the dispatcher did not restate it
  botId: string,                 // the dispatcher that named it (the one that starts it, for a card filed for later)
  origin: { threadKey?, via?, who? },
  asks: { id?, at, text, via?, who?, refs? }[],   // the person's messages about it; the first kept, then the latest 19
  tickets: string[],             // top-level tasks; a sub-task counts through the task that opened it
  projectId?: string, number?: number,   // filed under a project with its number there (both or neither)
  description?: string,          // ≤ 20 000 characters, from the board
  todo?: true,                   // filed for later: nothing handed out yet
  after?: string[],              // need ids it waits for, ≤ 10, not its own
  startWith?: string,            // the bot that starts it when its wait is over; none: the dispatcher
  links?: { kind: 'github', ref, url? }[],   // ≤ 10
  createdAt, updatedAt,
  closed?: { at, by: 'user' | 'dispatcher', outcome?: 'done' },   // outcome 'done': marked done; else dropped
  mergedInto?: string,           // merged away: the need that took it
  snapshot?: { status, done, total, failed, stalled, at },   // its last status, for when its tasks are pruned
}
NeedRow = {
  id, title, auto?, ref?: 'OPC-12', projectId?, number?, links?,
  status: 'todo' | 'waiting' | 'working' | 'failed' | 'done' | 'stopped',
  done, total, failed?, stalled?, waiting?: string[] /* task ids asking the person */,
  bots: string[], via?, who?, threadKey?, asked? /* the first message, ≤ 200 */,
  latest?: { status, at, botId, ticket, preview },   // a question waiting for the person first, else the latest report
  after?: { id, title, status, ref? }[], afterStuck?: true, startWith?,   // a card in To do only
  createdAt, updatedAt, endedAt?, closed?,
}
NeedView = NeedRow & { asks, description?, tickets: TicketRow[], results: { at, botId, ticket, text }[] /* done reports */ }
```

Status (first match): closed → `done` with `outcome: 'done'`, else `stopped`; `todo` with no task → `todo`; a task in
`question`, or open with an unanswered `blocked` → `waiting`; a task open → `working`; all ended with one `done` →
`done`; one `failed` → `failed`; else `stopped`. Work handed out (a task counted toward it, a start, or a merge into
it) takes a card out of To do and makes a closed one live again. `state.needs` counts `waiting` (with `failed`) and
`working`.

**Which need a task counts toward**, when the router home opens or adds to one with `bot_send_message`: the one `need`
names (an id or a card; an unknown one is refused before anything opens: `no card OPC-99 on the board. …`); the need the task already counts toward (a
follow-up: the person's words of the turn join it); one this turn made under the same words (parallel calls); a new
one when `need` restates a request; with no `need` in a turn the person spoke in, a new `auto` one titled with their
first message (≤ 60 characters). Work nobody asked for (a teammate's message, a schedule) counts toward none; `need`
from any other conversation is ignored. The result's text ends with `It counts toward need <id> (card OPC-12)
("<title>").` A card in To do is refused unless it came, or was named, in this turn (`need n… is a card the person keeps
in To do; …`): only the person starts it.

**What the router reads**: `Open needs: n… OPC-12 "<title>" (<status>[, <done>/<total> done]); …` (`openNeedsOf`: open
needs and ones changed in the last day, To do left out, ≤ 8), after `[Panel]` in a panel message and as its own text block before
a chat message's source line.

### Routes

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `needs` | `?status=&project=<id>\|none&limit=&offset=` (`limit` ≤ 300, default 100) | `{ items: NeedRow[], next_offset }`, newest change first |
| GET | `needs/<ref>` | `ref`: an id or a card (`OPC-12`, any case) | `NeedView`; a merged id answers with the need that took it |
| POST | `needs/create` | `{ title, description?, projectId? (id or key), assignee? (a bot), start? (default true), after?: (id \| ref)[] }` | `{ ok, ...NeedView, startError? }`: a card that could not be handed out is kept, in To do, and `startError` says why. With `after`: kept in To do, waiting, `assignee` as `startWith` |
| POST | `needs/<ref>/start` | `{ assignee? }` | `{ ok, ...NeedView }`; only a card in `todo` or `stopped` (`this card is under way already: …`); starts a waiting card at once |
| POST | `needs/<ref>/done` | `{}` | `{ ok, ...NeedView }`: open tasks ended `done` by the user, the card closed with `outcome: 'done'` |
| POST | `needs/<ref>/rename` | `{ title }` | `{ ok, ...NeedView }` |
| POST | `needs/<ref>/drop` | `{}` | `{ ok, ...NeedView }`: open tasks stopped by the user |
| POST | `needs/<ref>/save` | `{ title?, description?, projectId? ('' for none), after?: (id \| ref)[] ([] for none), startWith?: bot ('' for the dispatcher) }` | `{ ok, ...NeedView }`. Another project gives it the next number there, and the tasks it opens from then on work on that project (tasks it has keep theirs). Everything is checked before anything changes |

### Starting a card

A card the person files gets `origin: { via: 'board', who: 'the user' }`, `asks: [{ at, text: title + '\n\n' +
description, via: 'board' }]` and `botId` = the dispatcher. A start that reaches no one puts back what it changed (To
do, dropped, the dispatcher that named it).

- **To the dispatcher** (no `assignee`, or the dispatcher, or a lone dispatcher): `send` as a panel message whose text
  is the title and description, logged with `need: <id>` (`GET messages` adds `card`). The router reads, after
  `[Panel]` and `Open needs:`, `[Card OPC-12] The user filed this on the board as need n… ("…") in project OPC (…) and
  handed it to you. The tasks you open for it count toward it (pass need n…; they work in the project's folder). When
  you answer it yourself without handing anything out, mark it done with bot_need (action done).` A lone dispatcher
  reads the project's folder instead and marks it done itself. In that turn a `bot_send_message` with no `need`, or
  with a restatement when the card is all the person said, counts toward the card; the card's text joins no need as new
  words, and a card named in its own turn takes none of the turn's other words. New work in a turn that holds several
  cards, or a card and other messages of the person's, must name its need (`this turn has several cards from the
  board: pass \`need\` …` / `this turn has card n… "…" and other messages from the person: pass \`need\` …`); a message
  added to a task already counted toward a need never moves it.
- **To one teammate** (`assignee`, router mode): a ticket `{ requester: { kind: 'session', sessionId: <dispatcher
  home>, botId: <dispatcher> }, origin: { threadKey: 'panel:<home>', who: 'the user' }, board: true, projectId }`,
  counted toward the card before it starts. The dispatcher's chat logs `{ from: 'user', to: <bot>, chat: <dispatcher>,
  kind: 'user', thread: 'panel:<home>', ticket, need }` (pending until the task starts); a reply to it goes to the task,
  and its reports show in that chat as for any task the dispatcher opened from the panel. The dispatcher gets `[Board]
  The user handed card OPC-12 "…" (need n…) to @bot themselves: task t…. …` injected. The worker reads `New task t…
  from the user, from the board: …`, and the panel reads the task as asked by the person.

### Cards named

A card reference is `KEY-N` (any case) with no letter, digit or `-` before it and no letter or digit after it, naming
an existing card. In a message to the router home (the panel, a thread of it or a chat app):
- **Leading**: a message that starts with one (spaces before it allowed) whose card has exactly one live task (not
  archived, not stopped by a person) goes to that task as the person's message, like a reply in a task's thread: from
  the panel it is logged in the dispatcher's chat as `{ from: 'user', to: <bot>, chat: <dispatcher>, kind: 'user',
  thread: 'panel:<home>', ticket, need }` (`bots:panel:<id>:<ticket>`); from a chat app (`createChannels` dep
  `cardRoute(owner, text) => { need, ticket } | null`) through `toTickets` with `meta.card`. A task that answers the
  person itself is subscribed to that Thread and shows in it. The dispatcher gets a `[follow_up]` note. Its words join
  the card's need. When the task does not take it, the message goes to the router as usual.
- **Otherwise** the router reads, after `Open needs:`, `Cards named: n… OPC-12 "…" (working, 1/2 done), open tasks t…
  (@forge, working); …` (≤ 5 cards; a card in To do adds `— in To do: it starts when the person says so`). The turn's
  asks carry `refs` (need ids named).

### Waiting cards

Only a card in To do waits (`only a card in To do waits for others: this one is under way already`). Refused: an
unknown card (`no card X to wait for`), itself, more than 10, and a loop (`OPC-3 already waits for this card: they
would wait for each other`). Its wait is `ready` when every card it waits for is `done` (a merged one is followed, a
pruned one dropped from the list), `stuck` when one is `stopped` or `failed` (`afterStuck`: it does not start by
itself), else waiting. After any change of a need (on the next tick) and at every upkeep, each ready card starts with
`startWith` as the assignee; a start that fails is tried again 4 minutes later at the earliest. It starts as a card
does with, for each card it waited for, `It waited for OPC-11 ("…"), which is done now: "<its latest done report, ≤
600 characters>"` (and `… (bot_recall need/OPC-11 reads all of it)` when cut): below its text for a task of one bot, or
on the lines after the `[Card …]` header, which then reads `… to start once other cards were done; it starts now.`

## Projects

A **project** groups cards and numbers them (`OPC-12`); its tasks work in its folder and read its brief and memory.

```ts
Project = {
  id: string,                    // pj + 8 [a-z0-9]
  key: string,                   // 2–6 [A-Z0-9], a letter first, unique; cards read `${key}-${number}`
  name: string,                  // ≤ 60 characters
  brief: string,                 // ≤ 4000 characters; every task of the project reads it
  dir: string,                   // '' or an absolute path to an existing folder other than / (`~/` expanded on save)
  repo?: string,                 // its GitHub repository: owner/repo, or host/owner/repo on GitHub Enterprise; unique
  last: number,                  // the last card number given; numbers only go up
  createdAt, updatedAt,
}
ProjectView = { id, key, name, brief, dir, repo?, next /* last + 1 */,
                counts: { todo, working, waiting /* + failed */, done, stopped }, createdAt, updatedAt }
```
A key left out on create is suggested from the name: initials of its words (`One-person company` → `OPC`), pinyin
initials of a Chinese name (`内容工作室` → `NRGZS`), the first three letters of one word, numbered when taken (`OPC2`).

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `projects` | – | `{ items: ProjectView[] }`, by key |
| POST | `projects/save` | `{ project: { id?, name, key?, brief?, dir?, repo? } }` (no id = create; only the fields given change) | `{ ok, project: ProjectView }`; errors: `a project needs a name`, `the key OPC is taken by another project`, `a project key is 2–6 capital letters…`, `there is no folder …`, `… is a file, not a folder`, `the folder must be a full path …`, `acme/site belongs to project WEB already` |
| POST | `projects/delete` | `{ id }` | `{ ok, cards }`: its cards are filed under none (number dropped); its memory is dropped; tasks with a Session keep it, tasks not started yet lose `projectId` |

A ticket the router opens is counted toward its need before it starts, so it gets the need's project then; a sub-task
takes its parent's. The assignment adds `It is for card OPC-12 ("…") of project OPC (…).` after its origin line. A
router dispatcher's persona adds `## Projects` (each `- KEY — name: the brief's first line`, and when to pass
`project`); prompts read the projects as they are assembled, so a change applies at the next step. The project dialog
has **Choose folder…** (`data-dsh-bots-project-pick`) when the Host offers a folder dialog (`__DSH_DIRECTORY_PICKER__`, else
`uiWorkspace.pickDirectory`).

## Tools

Every conversation of a bot gets these tools. A Harness sub-agent or fork (Session header `origin: 'subagent'` with a
`parentSession`) uses them as the bot home or task Session it descends from, with that one's limits; a helper of a
conversation of no bot acts as no bot. One whose line cannot be traced (a creator that is gone and was no bot's, or a
loop) acts for no one: `bot_send_message`, `bot_reply`, `bot_ticket`, `bot_create`, `bot_delete` and the memory tools
refuse it (`bot_schedule` too, unless it names `bot`), and `bot_recall` reads nothing. A tool's `presentationMeta`
leaves out empty fields (Harness rejects `undefined` as not lossless JSON). Messages between a pair of bots (new tasks
and added messages included) are limited to 16 in 10 minutes. `to` and `from` in results are bot faces (`{ id, name,
handle, avatar, role }`).

### Bots

- `bot_list {}` — the bots: handle, name, role, team (`, team <id> (<name>)[, lead]`), status, bio, skills, apps and
  scheduled tasks.
- `bot_create { name, handle?, bio?, persona?, initials?, color?, avatar_prompt?, avatar_file?, skills?, team? }` —
  `skills: { name, description?, content? }[]`; `team`: an id or name, as `bot_list` shows them.
- `bot_update { bot, name?, bio?, persona?, initials?, color?, avatar_prompt?, avatar_file?, avatar_clear?,
  add_skills?, remove_skills?, make_dispatcher?, team?, lead? }` — only the fields given change; `team: 'none'` takes
  it out of its team; `lead` only for a bot of a team, never `true` for the dispatcher. Skills past the 50 on at once are
  added switched off.
- `bot_delete { bot }` — deletes a bot and its scheduled tasks and archives its conversation; only when the person
  asked.

### `bot_send_message { to?, text, ticket?, status?, title?, thread?, report_to?, need?, project?, images? }`

| Called from | Arguments | Does | Result |
|---|---|---|---|
| a task Session | no `to` (or the requesting bot, or `ticket` = its own id), `text`, `status` (required) | a report: `progress` is only recorded; `done`, `blocked`, `question` reach the person or the requester at once ([Reports](#reports)); `done` ends the task | `{ ok, text, ticket: TicketRow, to, from }` |
| a task Session | `to`, `text`, `title?` | opens a sub-task (requester: this task) | `{ ok, text, ticket, stage, to, from }` |
| a bot's home | `to`, `text`, `title?`, `thread?`, `report_to?`, `images?`; the router home also `need?`, `project?` | opens a task; starts at once when a slot is free, else queued | `{ ok, text, ticket, stage, need?, to, from }` |
| the requester's Session, the requesting bot's current home, or the router home | `ticket`, `text`, `to?` (must be the task's bot) | adds a message to the task; an ended task opens again, except one the user stopped; with every slot taken it waits in `parked` | `{ ok, text, ticket, to, from }` |
| a bot's home or a task Session | `to` the dispatcher | a DM into the dispatcher's home, which takes no tasks; one from a task names it, so an answer goes to that task | `{ ok, text, to, from }` |
| a conversation of no bot | `to`, `text` | into the other bot's home | `{ ok, text, to, from }` |

- `title` defaults to the first line of `text`; `status` is refused outside a report.
- `thread`: only when the turn has several places ([Where replies go](#where-replies-go)): one of the turn's Threads (a
  key, a panel thread's `p…` id) or `panel`; refused with the choices when left out then. A sub-task takes no Thread.
- `report_to: 'me'` has the task's reports come to the asking bot instead of the person (`Ticket.relay`).
- `need`, `project`: see [Requests](#requests-and-the-board) and [Projects](#projects); an unknown project is refused
  before anything opens (`no project "X"; projects: OPC (…), …`).
- `images: string[]`: left out, a new task or a message carries the turn's images (a home's) or the task's (from a task
  conversation); `[]` carries none. Adding to a task carries only images it does not have; from a task's own
  conversation, only the ones named. Reports carry none. The answer says `It carries N images.`
- File references ([File references](#file-references)) take no argument: a new task or a message carries the turn's
  (a home's) or the task's (from a task conversation); adding to a task from a home carries the turn's it does not
  have. Reports carry none. The answer says `It carries a file reference.` (`… an image and 2 file references.`).
- Refused: the dispatcher handing work to itself (`you are the dispatcher: hand the work to a teammate, …`), a task for
  the dispatcher (it takes none: its teammates' messages go into its conversation), a team member past its lead
  ([Leads](#leads)), a pair over its limit.

### `bot_reply { text, ticket?, thread? }`

Answers in a topic or chat: `ticket` (the chat that task came from) or `thread` (a key, `thread/<key>`, or a panel
thread's `p…` id). It resolves this turn's Threads first, then a stored Thread whose chat app is connected and has
someone paired (or vouches for its people), then a panel thread of the bot's own chat. Only from a bot's home: refused
in a task Session and in conversations of no bot. Result `{ ok, text, thread, via? }`; a panel thread only logs the
reply.

### `bot_recall { ref, offset? }`

| ref | Result |
|---|---|
| `tickets` | `{ ref, items: Card[], total, next_offset? }`, open tasks first, then failed, then ended, archived last; newest first within each |
| `ticket/<id>` | `{ ref, card: Card, text /* ≤ 200 characters of the assignment */, chars?, more: string[] }` |
| `ticket/<id>/text`, `ticket/<id>/source`, `ticket/<id>/reports`, `ticket/<id>/transcript` | `{ ref, text, offset, chars, next_offset? }`: the assignment, the chat message it came from (the person's words, the chat context read with them, the chat app's ids), every report (newest first), the task Session's conversation |
| `thread/<key>` | `{ ref, thread: { key, kind, label, last_at }, items: Card[], total, next_offset?, recent?: { at, who, text }[] }` |
| `bot/<handle>` | `{ ref, bot: { handle, name, bio, dispatcher? }, items: Card[], total, next_offset? }` |
| `needs` | `{ items: { id, title, status, done, total, card?, …, tasks }[] }`, newest 30 |
| `need/<id>`, `need/OPC-12` | the request and its tasks |

`task/…`, `tasks`, a bare task id and `@handle` work too. Lists come 20 to a page, text 4000 characters to a page;
pass `next_offset` as `offset`. `Card = { id, title, bot, stage, requester, parent?, children?, origin?: { thread?,
label?, via?, who? }, threads?, last_report?: { status, at, preview }, error?, waiting_for?, archived?, updated_at }`
(list items leave out `children`, `threads` and `error`). From a task Session only that task, its parent, its sub-tasks
and its Threads can be read. `recent` comes from the timeline.

### `bot_ticket { id, action: 'stop' | 'close' | 'retry' | 'status' }`

On a task this conversation asked for (the router home and conversations of no bot: any task; a task Session: only
its sub-tasks). `stop` ends it as stopped and `close` as done, both cancelling its running turn; `retry` opens it again
with the assignment (a bot cannot retry one the user stopped); `status` asks an idle working task for a report (or says
what it waits for). Result `{ ok, text, ticket: TicketRow }`.

### `bot_need { need, action, title?, into?, project?, after?, start_with? }`

The router home, or a conversation of no bot (it works in the dispatcher's home whether it routes or not). `need` and
`into` take an id or a card (`OPC-12`). Actions: `rename` (`title`), `merge` (`into`), `drop` (its open tasks stop),
`done` (open tasks closed, the need closed as done), `file` (`project`: a key; empty for none), `after` (`after`:
references or ids, comma-separated, empty for none; `start_with`: `@handle`). Result `{ ok, text, need: NeedRow }`.

### `bot_schedule { action, bot?, id?, title?, prompt?, kind?, at?, every_minutes?, time?, weekdays?, cron?, time_zone? }`

`action`: `create`, `list`, `update`, `delete`, `pause`, `resume` or `run`. `bot`: the @handle the task belongs to
(create, list; default the caller). `kind`: `at` (`at`), `every` (`every_minutes`), `daily` (`time`), `weekly` (`time`,
`weekdays`), `cron` (`cron`); `time_zone` an IANA zone (default the machine's). See [Schedules](#schedules).

### Memory tools

- `memory_save { text, scope?: 'self' | 'team' | 'project', project?, until?, kind?, replace_id? }` — `project`: a key
  (default the task's project, else refused: `this conversation works on no project …`); `until`: `YYYY-MM-DD`, else
  refused. With `replace_id` the note takes the `until` given, or none.
- `memory_forget { id, scope? }` — scope defaults to what the id says (`t-` team, `p-` a project, `n-` the bot's own);
  a `p-` id is found in whichever project holds it.
- `memory_search { query }` — notes, journal lines and digests with every word, and tasks: every word in the title,
  else in one of its reports (most recently changed first, ≤ 10). A project note reads `(project KEY)`. From a task
  Session: only its task, parent and sub-tasks, and only their journal lines; no digests; its project's notes
  (elsewhere every project's). Result `+= { tickets: string[] }`.

## Memory

```ts
Note = { id /* 'n-…' a bot's, 't-…' the team's, 'p-…' a project's */, text,
         kind: 'fact' | 'preference' | 'person' | 'project' | 'procedure' | 'lesson',
         pinned?, until?: 'YYYY-MM-DD' /* its last day; a pinned note never runs out */,
         source: 'auto' | 'tool' | 'user' | 'dream', at, updated }
Journal = { id, at, bot, task, ticket?, trigger, title, summary }   // trigger 'ticket' for a task's summary
Digest = { date /* YYYY-MM-DD local */, text /* Markdown */, at }
```

A memory scope is a bot's id, `'team'` (shared notes) or a project's id (`pj…`, at most 60 notes per project). The
prompt (`memoryText`) leaves out notes past their day and writes `(until YYYY-MM-DD)` after one that has a day; a task
whose ticket has `projectId` also reads `### Project memory: KEY · Name (every task of this project reads it)`. Its
rules: shared notes only for what every bot needs in every piece of work; one project's matters in `project`; never
the state of work, where a file is, or who is on the team; `until` for dated notes. Notes and the nightly digest are
written in the language the person writes to the bots in, judged from their last messages (else the journal and
notes, else the machine's language). `lib/memory.mjs` serves `notes(scope)`, `search(q, { bot, projects })`,
`prune(today)`, `dropProject(id)`, `projectIds()` and `isProjectScope(scope)`. In the panel, **Team memory** has
**Shared notes** and **Project memory** (a project picker, then its notes); a note shows `until …` or `past its day …`,
and adding and editing take a date.

- **After a run**: a home's run, or a task's runs once the task ends, get a journal line; one that did something and is
  not a short exchange is summarized by the memory model into the journal and notes when `settings.memory.auto` is on
  (`reflectionPrompt`: with the task's project, `{ summary, notes, team, project }`, the same rules and today's date).
- **Nightly consolidation** (`dream`, at `settings.memory.dreamTime`, or `memory/dream`): `prune(today)` first
  (`result.expired`: unpinned notes past their day, every scope), then each bot, then the team with every project's
  notes (`dreamTeamPrompt` → `{ digest, team, projects: { KEY: edits } }`; the projects' edits go first, by key; a team
  note about one project moves there; an answer naming a key that is no project's keeps every team note it would
  remove). It may answer with up to 16 000 tokens. A model's `update` keeps a note's `until` unless it gives one (`null`
  removes it).

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `memory` | `?bot=<id>` | `{ scope, notes, journal /* newest first */, topic, topics /* past, newest first */, model, settings, today, tz }` |
| GET | `memory` | `?bot=team` | `{ scope: 'team', notes, digests, journal, dream: { lastDate, lastAt, result }, projects: { id, key, name, count }[], settings, today, tz }` |
| GET | `memory` | `?bot=<projectId>` | `{ scope, project: { id, key, name }, notes, today, tz }` |
| POST | `memory/put` | `{ scope: botId \| 'team' \| projectId, note: { id?, text?, kind?, pinned?, until? ('' clears it) } }` | `{ ok, note }` (no id = add) |
| POST | `memory/delete` | `{ scope, id }` | `{ ok }` |
| POST | `memory/dream` | `{}` | `{ ok, result: { at, reason, bots: { bot, added, updated, removed }[], digest, team?, expired, errors } }` |

`state.bots[].memoryNotes` and `state.teamNotes` are counts.

## Usage and prices

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `usage` | `?range=today\|7d\|30d\|90d\|all&bot=<id>&tz=<minutes east of UTC>` | `Report` |
| GET | `prices` | – | `{ overrides, list: { name, count, fetchedAt, loading, error }, models: { model, provider, price }[] }` |
| POST | `prices` | `{ model, price: { input, output, cacheRead?, cacheWrite?, currency: 'USD' \| 'CNY' } \| null }` | `{ ok, …prices }` |
| POST | `prices/refresh` | `{}` | `{ ok, …prices }` |

```ts
Cost = { [currency]: number }
Totals = { tokens, input, output, cacheRead, cacheWrite, calls, cost: Cost, unpriced /* tokens */ }
Report = { range: { name, from, to, bucket /* ms */ }, totals: Totals & { tasks, cacheRate }, prev: Totals & { tasks },
  series: { t, tokens, byBot: { [botId]: tokens }, cost }[], bots: ({ bot, tasks } & Totals)[],
  models: ({ provider, model, priced, priceSource } & Totals)[],
  kinds: ({ kind: 'chat' | 'compaction' | 'memory' | 'dream' } & Totals)[], schedules: { id, title, bot, runs, tokens, cost }[],
  tasks: TaskView[] /* runs: running first, then newest */, topTasks: TaskView[],
  tickets: ({ id, bot, title, runs } & Totals)[],   // the window's calls by task, most tokens first, ≤ 60; runs that ended in the window or are running
  priceList }
TaskView = { id, bot, trigger: 'user' | 'chat' | 'schedule' | 'dm', via?, from?, sched?, ticket?, title, start, end,
             status: 'running' | 'done' | 'error' | 'stopped', tokens, calls, cost }
```
`usage.jsonl` holds one row per model call (`t`: the time, `tk?`: the task); `tasks.jsonl` one per run (`t?`: the
task). Prices come from your own table first (`settings.prices`), then LiteLLM's public
`model_prices_and_context_window.json` (chat rows only, cached in `price-catalog.json`). Costs are worked out when a
report is read, never stored, so a corrected price applies to past usage too. They are estimates.

## Schedules

A bot's scheduled tasks are Harness schedule entries targeting its home.

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `schedules` | `?bot=<id>` | `{ items: Task[] }` (a Harness schedule entry: id, title, prompt, kind, scheduledAt, status, lastDelivery, timing fields) |
| POST | `schedules/save` | `{ botId, id?, title, prompt, timing }` | `{ ok, task }` |
| POST | `schedules/delete` | `{ id }` | `{ ok }` |
| POST | `schedules/toggle` | `{ id, active }` | `{ ok }` |
| POST | `schedules/run` | `{ id }` | `{ ok }` |

`timing` is a Harness schedule timing: `{ kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Singapore' } }`,
`{ kind: 'every', every_seconds: 3600 }`, `{ kind: 'weekly', weekly: { time, time_zone, weekdays: [1..7] } }`,
`{ kind: 'cron', cron: { expression, time_zone } }`, `{ kind: 'at', at: 'ISO' }`. A run's answer reports to the
channel's first paired person when `scheduleReplies` is on ([Where replies go](#where-replies-go)).

## Settings

```ts
Settings = {
  topics: { idleHours, maxContextK },
  memory: { auto, model, dream, dreamTime },
  display: { botMessages: 'line' | 'short' | 'full' },   // how the panel shows messages between bots: one line each;
                                                         // that and two lines of the text; the whole message with a
                                                         // delegation's task card. Anything else reads as 'line'
  tickets: {
    maxWorking: number,                // 4; 1–32. Task Sessions working at once (a person's message may take one more)
    stallMinutes: number,              // 20; 1–1440. Quiet minutes before the status check, and again before the stall
    archiveHours: number,              // 24; 0–720. Hours after a task ended before its Session is archived (0: next upkeep)
  },
  dispatcher: 'router',                // always; a stored 'hands-on' reads as 'router' with routerNotice 'pending'
  routerNotice: null | 'pending' | 'dismissed',
  teamLeads: null | 'given',
  leadOffers: { [teamId]: 'dismissed' },
  teams: { [id]: { name?, tagline?, color?, custom?: true, at? } },
  leadNotice: null | 'dismissed',      // state.oldLeads was dismissed
  prices: { [model]: Price },          // your own prices, written by POST prices
  codex: { sync: boolean, route: boolean },   // the Codex login: kept in step with ~/.codex/auth.json, its route made
}
```

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `settings` | – | `{ settings }` |
| POST | `settings` | `{ patch: { topics?, memory?, display?, tickets? } }` | `{ ok, settings }`; `dispatcher` and `teams` in a patch are ignored |

## Images

```ts
Image = { id: string /* the attachment id */, url: '/__dsh_bots/image/<id>', width: number, height: number, name?: string }
```

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `images` | `{ mediaType: 'image/png' \| 'image/jpeg' \| 'image/webp' \| 'image/gif', data: base64 \| data URL, name? }` (≤ 40 MB) | `{ ok, image: Image }`. Harness's attachment store (`ctx.attachments.admitPromptContent`) checks the bytes against the type, normalizes and keeps the image; a refusal comes back as `{ ok: false, reason }` in its words. Without an attachment store: `sending images needs a Harness with attachments` |
| GET | `image/<id>` | – | the bytes, read through `ctx.attachments.readImage` (which verifies them against the reference), `content-type` the image's, `cache-control: private, max-age=31536000, immutable`; 404 for an id no message named |

- The panel uploads each image as soon as it is attached, so a message only names them: `send` and
  `tickets/<id>/message` take `images: string[]` (ids, at most 10); an id no message or upload gave is refused (`no
  image <id>: …`).
- `images.json` (`lib/images.mjs`): attachment id → `ImageAttachmentRef`, the newest 5000. Refs come from uploads, chat
  messages, and the `image` blocks of every `user/message` event in a bot's home or task conversation.
- To a bot, a message's images are `{ type: 'image', attachment: ImageAttachmentRef }` blocks after its text, then one
  text block: `[Image attached: <id> (<name>). To pass it on to a teammate, name its id in \`images\`.]` (`N images
  attached: …` for several). Logged messages and tickets keep `images: string[]` (ids).
- The images of a home turn's messages (not reports) are the turn's; `bot_send_message` carries them
  ([Tools](#tools)). A ticket keeps
  `images` (at most 10); its assignment (start, and a new conversation on recovery) has their blocks after the text. A
  message added before it starts adds its images to the ticket.
- Panel: an image button (`data-dsh-bots-attach`, `data-dsh-bots-attach-input`) in the chat, thread and task
  composers; paste and drop on the composer attach images; attached ones show above the box
  (`data-dsh-bots-attached-item`: `uploading` | `ready` | `error`). Messages show thumbnails (`data-dsh-bots-msg-image`)
  that open a lightbox (`data-dsh-bots-lightbox`; arrows, Esc).

## File references

A person's message may reference files of this computer. A bot is not tied to one folder, so any file may be
referenced: one of the folder the conversation works in by its path there, any other by its full path. Nothing of a
file is read, copied or uploaded by Bots: the bot gets the file's full path and reads it with its own tools and
permissions.

```ts
FileRef = { path: string /* the real, absolute path */, name: string /* for show: its path inside the conversation's folder (with `/`) when it is there, else its full path */ }
```

| Method | Path | Query | Answer |
|---|---|---|---|
| GET | `files` | `?bot=<id>&q=<words>&dir=<folder>?` or `?ticket=<id>&q=<words>&dir=<folder>?` | `{ ok, root, files: string[], truncated, elsewhere }`: the files of the folder `root` whose path has every word of `q` (any case), as paths inside it, at most 50, the closest first (the name itself matches, then the one nearer the top). Entries with a leading dot, `node_modules` and symbolic links are not listed; a search stops after 20 000 entries or 12 levels (`truncated`, also when more than 50 match). `elsewhere`: `root` is not the conversation's folder, so a file listed is referenced by its full path (`root` + `/` + the path listed). `{ ok: false, reason: 'no such bot or task' }` |

- `root` is the conversation's folder: for `bot`, the bot's configured folder (`workdirs`), else the shared Bots
  workspace; for `ticket`, its project's folder, else its bot's (as its Session is placed). With `dir` (a full path,
  `~` is the home folder) it is that folder. When `q` is a full path (`/…`, `~/…`) it is the folder that path names,
  whatever `dir` says: the longest part of the path that is a folder, searched by the words that follow it
  (`~/docs/plan` lists the files of `~/docs` with `plan` in their path); a `q` that is the full path of a file
  answers with that one file, a hidden one too.
- `send` and `tickets/<id>/message` take `files: string[]`, at most 10 (`a message carries at most 10 file
  references`): each a path inside the conversation's folder (as `GET files` lists them; `send` takes the bot's
  folder, a reply in a thread too, `tickets/<id>/message` the task's) or the full path of a file anywhere on this
  computer (`~` is the home folder). The Host resolves each to its real path (`lib/files.mjs`: a symbolic link is the
  file it leads to, and a file named twice is referenced once) and refuses the message, before anything is logged or
  sent, for a file that is not there (`no file …: it was moved or deleted`) and anything that is not a file (`… is
  not a file`). No folder bounds what may be referenced: the bot that gets the path reads it with the file tools and
  permissions it has.
- To a bot, the references are one text block after the message's words (before its images): `[File referenced:
  <path>. The person points you to this file on this computer: read it at this full path (your working folder may be
  another one). A task or message you send a teammate from here carries the reference by itself.]` (`N files
  referenced: <path>, <path>. …` for several). A file that is gone when the block is written reads `<path> (not there
  now: moved or deleted)`.
- Logged messages and tickets keep `files: FileRef[]`. The references of a home turn's panel messages are the turn's;
  `bot_send_message` carries them ([Tools](#tools)), and a ticket's assignment (start, and a new conversation on
  recovery) has their block. A message added before a ticket starts adds its references to the ticket. Since a
  reference is a full path, a teammate working in another folder reads the same file, with the file tools it has.
- Panel: a file button (`data-dsh-bots-file-button`) in the chat, thread and task composers opens the picker
  (`data-dsh-bots-file-picker`: a search box `data-dsh-bots-file-search`, which also takes a pasted full path; the
  folder searched `data-dsh-bots-file-root`, with `data-elsewhere` when it is not the conversation's; rows
  `data-dsh-bots-file-option`). **Another folder…** (`data-dsh-bots-file-dir`, when the Host has a folder dialog)
  searches a folder the person chooses, and `data-dsh-bots-file-dir-reset` goes back to the conversation's. Picked
  files show above the box (`data-dsh-bots-file-ref`, removed with `data-dsh-bots-file-ref-remove`). Messages and a
  task's assignment show a chip per file (`data-dsh-bots-msg-file`, the full path as its tooltip). A file that is no
  image dropped on a composer is not taken (a page is not told where a dropped file is); the panel says to use the
  picker.

## Chat channels

People message the team from a chat app; replies go back to the chat. A channel is an ordinary app on a bot whose
catalog entry has `kind: 'channel'`; it is **not** an MCP server (`mcpConfigFor` returns `null`, no MCP client starts
for it, and editing it never restarts the bot's MCP clients).

```ts
// Catalog (category 'work'); `logo` names logos/<logo>.png, served at GET /__dsh_bots/logo/<logo>.png
//   telegram       #229ED9  fields: token (secret)
//   discord        #5865F2  fields: token (secret)
//   feishu-chat    #3370ff  channel 'feishu', fields: appId (text), appSecret (secret)   // Feishu or Lark, found by App ID
//   slack-chat     #4a154b  channel 'slack', fields: token (bot, xoxb-), appToken (app-level, xapp-; both secret)
//   github-issues           channel 'github', fields: token (secret), repos, label (default 'bots')
App.values[secret field]   // in `state` and every route that returns a bot, a stored secret reads as '••••••••';
                           // POST save with the mask keeps the stored value, any other value replaces it.

ChannelView = {
  kind: 'telegram' | 'discord' | 'feishu' | 'slack' | 'github',
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
  vouched?: true, watching?: { repos, label },   // GitHub
}
```

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `channels/code` | `{ botId, appId }` | `{ ok, code, expiresAt }`: a new pairing code (the old one stops working) |
| POST | `channels/unpair` | `{ botId, appId, userId }` | `{ ok }` |
| POST | `channels/options` | `{ botId, appId, scheduleReplies: boolean }` | `{ ok, scheduleReplies }` |
| POST | `channels/reconnect` | `{ botId, appId }` | `{ ok }`: drop and reconnect (after fixing a setting in the chat app's console) |

### Behaviour (`lib/channels.mjs`)

- A connector runs per enabled channel app with a token; it is started, restarted (token change) and stopped
  (disabled, removed, bot deleted, plugin disposed) from the roster. One token runs in one place; a second app with the
  same token shows `hint: 'duplicate'`.
- Only paired people are heard. Pairing: a private chat, the current code (`CODE` or Telegram `/start CODE`); 5 wrong
  codes per person or 20 per code lock pairing until a new code. Strangers get at most one "this bot is private" line
  per private chat per day; groups stay silent. In groups the bot only hears messages that mention it or reply to it.
- A paired person's message becomes a user prompt (`source.kind: 'user'`), routed as in [Inbound
  messages](#inbound-messages). A typing indicator runs while the bot works (every 5 s).
- Replies follow [Where replies go](#where-replies-go). Telegram gets plain text (Markdown markers removed); apps that
  render Markdown get it; replies are split at the app's limit (Telegram 4096, Discord 2000).
- A message id at or below the highest one handled in that chat is ignored (kept in `channels.json`), so a chat app
  handing a message out again after a restart never runs a task twice.
- Telegram reads `BOTS_TELEGRAM_API` (default https://api.telegram.org), so a local stand-in of the Bot API can be used
  for testing.

### Connector contract

A connector is `lib/channels/<kind>.mjs`, transport only (`lib/channels.mjs` does pairing, routing and reply targets).

```js
export const kind = 'telegram';
export const TEXT_LIMIT = 4096;      // the app's message limit
export const MARKDOWN = true;        // optional: the app renders Markdown replies
export const THREADS = true;         // optional: every part of a reply goes to the thread of `replyTo`
export const VOUCHED = true;         // optional: the app vouches for its people; nobody is paired (GitHub)
export function links({ account, code, values }) → { link?, invite? }   // optional
export function createConnector({ token, values, onMessage, onStatus?, fetchImpl?, WebSocketImpl?, apiBase?, log? }) → {
  start(): Promise<{ id, username, name }>,   // resolves once authenticated; rejects on a bad token
  stop(): Promise<void>,                      // idempotent; nothing reconnects afterwards
  send(chatId, text, { threadId?, replyTo? }?): Promise<{ ids: string[] }>,   // splits at TEXT_LIMIT; the app's ids of what it made
  typing(chatId, { threadId? }?): Promise<void>,
  readImages?(msg): Promise<{ mediaType, data: Uint8Array }[]>,  // a message's `images`; never throws
}
// onMessage({ chatId, messageId, userId, userName, text, isDirect, mentioned, threadId?, order?, chatTitle?,
//             source?, context?, images?, trusted?, issue? })
// onStatus({ state: 'connecting' | 'connected' | 'error' | 'stopped', detail?, fatal? }) — never the token
```
`order` is a decimal string rising within a chat (the replay guard); `source` overrides the label in the source line;
`ids` from `send` are Telegram's `message_id`, Slack's `ts`, Discord's `id`, Feishu's `message_id`, GitHub's comment id.
`createChannels` takes `onSent({ tag, appKey, chatId, threadKey, ids })`, called after a send made with a `tag`
(`noteReply`, `replyTo` and `post` take one; Bots tags a home's replies and `bot_reply` with `{ sessionId, seq }`, so a
reply to one of those messages forks there), and `homeKey(sessionId)`, the Thread a Session's input without one belongs
to (a discussion's own key; default `panel:<sessionId>`).

### Chat context (Feishu)

`context` is the chat context the connector read with the message: `{ kind: 'root' | 'topic' | 'quoted' |
'forwarded', who, text }[]`, oldest first within a kind. The hub renders it (`contextText`) as one block, `[Chat
context, read from Feishu with this message]`, which the bot reads right after the message (home, discussion and a
follow-up to a task alike), and which the turn's origin carries as `context`, beside `said` (the message's own words)
and `messageId`. Feishu reads, for a message addressed to the bot: the message it replies to (`quoted`; in a topic the
parent is its first message, a `topic` item), the first message of its reply chain (`root`) or the ten latest earlier
messages of its topic (`topic`, `GET /im/v1/messages?container_id_type=thread`), and for a `merge_forward` in a DM (its
`text` is `[Forwarded chat history]`, `forwarded: true`) up to 30 messages it holds; the hub also puts a forward's
context on the origin (not the delivery) of the next message in that Thread within 10 minutes that has none, so a task
opened from "summarize this" keeps the history. Each item is ≤ 800 characters (the quoted one ≤ 2000), ≤ 8000 in all,
newest kept; files and images read as `[file: name]`, `[image]`. It waits at most 6 s; a missing permission
(`im:message:readonly`, `im:message.group_msg`) is logged once and that lookup rests for 30 minutes.

### Images (Feishu)

A message may carry `images` (Feishu's image keys, at most 10), and the connector has `readImages(msg)`. In an `image`
message, or a `post` with `img` elements, each image reads as `[image]` where it was (an image alone is the message
`[image]`); images of the quoted message, a topic or a forward stay `[image]` in `context`. The hub calls `readImages`
only after pairing, the group check (an @-mention or a reply to the bot) and the replay guard, so a stranger's image is
never fetched, and passes what came as `images` to `deliver` and `toTickets` beside `context`. Feishu reads each one
from `GET /im/v1/messages/{message_id}/resources/{image_key}?type=image` (permission `im:message:readonly`), all at
once, each within 20 s and 20 MB, typed by its bytes (PNG, JPEG, WebP, GIF); one that fails, is too big or is another
format is logged and left out, a missing permission is logged once and images rest for 30 minutes. The Host stores each
through the attachment store as an uploaded image ([Images](#images)); one it refuses is left out. The text keeps its
`[image]` either way.

## GitHub Issues

A chat channel of kind `github` (catalog app `github-issues`; fields `token` (secret), `repos` (comma separated),
`label` (default `bots`)). `lib/channels/github.mjs` polls; there is no webhook and no public address.

### Transport

- Every 60 s, per repository: `GET repos/{repo}/issues?labels=…&state=open&sort=updated&direction=asc&since=…` and
  `GET repos/{repo}/issues/comments?sort=updated&direction=asc&since=…`, each with `If-None-Match` (a 304 costs no rate
  limit), up to 5 pages. Pull requests are left out. A 401 stops it (`GitHub rejected the token: …`); a 403 or 429 waits
  for the reset (≤ 15 min).
- An issue is passed on once (`messageId` `i<id>`, `threadId` its number, `text` `#N title` and its body, cut at 8000
  characters with its address, `issue: { repo, number, title, body, url, author, labeledBy? }`); afterwards only
  comments on issues passed on (`c<id>`; comment ids only grow, so an edited one is not new), never the token's own
  account's or a body holding `<!-- dsh-bots -->`.
- `trusted`: an issue whose author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`, or whose latest
  `labeled` event (for the label) has an actor that `GET repos/{repo}/collaborators/{login}` answers 204 for (cached 10
  min); a comment by such an author.
- Cursors (`memo`, in `channels.json` under the channel's record): `{ repos: { [repo]: { since, comments, lastComment,
  issues: number[] (≤ 1000) } } }`. A first start sets them to now.
- `send(repo, text, { threadId })` posts `text` + `\n\n<!-- dsh-bots -->` as a comment on that issue (`{ ids: [id] }`);
  without an issue it throws. `typing` does nothing. Exports `VOUCHED = true`, `MARKDOWN = true`, `TEXT_LIMIT = 60000`.
- **GitHub Enterprise**: a repository is `owner/repo` on github.com and `host/owner/repo` on any other server
  (`cleanRepo`: from `https://host/owner/repo[/…]`, `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo`, or a
  bare `host/owner/repo`; a host needs a dot or a port, so the kept form reads back the same). Projects, channel `repos`,
  `chatId`, `issue.repo` and link refs (`host/owner/repo#N`) all use that form; a link's `url` may be any http(s)
  address. A channel's API is `https://host/api/v3/` (`https://api.<host>/` for `*.ghe.com`; `api.github.com` without a
  host, `apiBaseOf`); a channel whose repositories are on more than one server stops with a fatal error. `send` refuses
  a repository on another server. The channel panel links `repoUrl(repo)/issues?…`.

### The hub

- A module with `VOUCHED` pairs nobody: no pairing code, no welcome or greeting answers. A message with `trusted: true`
  counts as a person's (not stored); any other is ignored without an answer and counted (`view.ignored`).
- Its Threads are reachable for replies and reports though nobody is paired (`lookupThread`).
- A message with `issue` calls `deps.fileIssue(owner, issue, { threadKey, who, via })` before it is routed; a need id
  back is passed on as `meta.issueCard`.

### Cards from issues

`fileIssue` files a card unless one already links that issue: `{ title, description: body, origin: { threadKey, via:
'github', who }, asks: [title + body], links: [{ kind: 'github', ref: 'owner/repo#N', url }], todo: true }`, under the
project whose `repo` is that repository (with its next number). `deliver` gives the bot, before the source line, the
card's header — `[Card WEB-1] @kada asked for this in GitHub issue acme/site#12; it is on the board as need n… ("…") in
project WEB (…). Answers in this thread are comments on the issue, which everyone who can see the repository reads. …`
— logs the message with `need`, and starts the card once the bot has it (`botId` = that bot). In the dispatcher's
turn, its new work counts toward the card as for a board card.

## Storage

Everything lives under `~/.dsh/cache/bots/` (`$DSH_HOME/cache/bots/` when `DSH_HOME` is set). The roster, tasks,
requests and projects are written whole through a temp file, mode 0600. A `tickets.json` or `projects.json` that is not
JSON in its shape is set aside as `<name>.corrupt-<ms>` and starts empty; a `tickets.json` that cannot be read
(permissions, a directory in its place) stops the plugin from starting, with a log line, so nothing writes over it.

| File | Holds |
|---|---|
| `bots.json` | the roster: `{ version, bots: Bot[] }` |
| `messages.jsonl` | [the timeline](#the-timeline), append-only |
| `tickets.json` | `{ version: 1, tickets: Ticket[], threads: Thread[] }`: the newest 500 archived tasks are kept; Threads no task is subscribed to are dropped |
| `needs.json` | `{ version: 1, needs: Need[] }`: the newest 500 settled needs (done, failed or stopped) and every open one |
| `projects.json` | `{ version: 1, projects: Project[] }`, at most 100 |
| `discussions.json` | `{ items: { [threadKey]: Discussion }, anchors: { [ref]: { sessionId, seq, at } } /* ref: msg:<id>, chat:<appKey>:<chatId>:<messageId> or a Thread key; newest 4000 */, seen: { [rootId]: number }, told: { [botId]: number } }`; discussions past 2000 lose the oldest archived ones. A new discussion is written at once, the rest within 200 ms |
| `channels.json` | per channel: pairings, pairing codes, the replay guard's highest message ids, `scheduleReplies`, a connector's cursors (`memo`) |
| `images.json` | attachment id → `ImageAttachmentRef`, the newest 5000 |
| `settings.json` | [Settings](#settings) |
| `topics.json` | per bot, the current topic's activity and a short history of past ones |
| `memory/` | `notes.json` (`{ bots, team, projects }` of `Note[]`), `journal.jsonl`, `digests.json`, `dream.json` |
| `usage.jsonl`, `tasks.jsonl` | one row per model call, one per run ([Usage](#usage-and-prices)) |
| `price-catalog.json` | the public price list, cached |
| `skills/` | the files of imported skills |
| `avatars/` | avatar pictures |
| `seeded` | written once the first team was made, so an emptied roster is not seeded again |

```ts
Discussion = {
  key, botId, sessionId, rootId,
  source?: { sessionId, seq? },    // where it was forked
  title?, createdAt, lastAt,
  archivedAt?, noted?: true,       // noted: its first message carried the [Thread] note
  exact?: false,                   // forked at the latest turn, not at the root
}
```
