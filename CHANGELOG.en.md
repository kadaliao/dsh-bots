# Changelog

[简体中文](CHANGELOG.md) | English

What changed in each version of Bots, newest first, and what to do after upgrading. Bots tells you when a new
version is out ([Updates](README.en.md#updates)).

## 0.20.1 — 2026-11-27

- **Files can be dropped on the message box.** Images are attached as before; another file is referenced by its
  full path when Harness tells the panel where it is, and otherwise the file picker opens searching its name, so one
  click references it ([#18](https://github.com/kadaliao/dsh-bots/issues/18)). See
  [The chat](README.en.md#the-chat-reply-to-a-message-to-open-a-thread).
- **The version and the source are at the foot of the rail.** Under the views, Bots shows which version this is and
  a GitHub mark that opens [kadaliao/dsh-bots](https://github.com/kadaliao/dsh-bots).
- **Discover and the Plugins page show the Chinese README by default.**

## 0.20.0 — 2026-11-27

- **A new card takes screenshots and files.** In **New card**, paste, drop or pick screenshots, and pick files of this
  computer: the project's folder first (the dispatcher's without a project), or any other folder. Files are named by
  path, not copied. However the card starts, now, from To do or once the cards it waits for are done, they go out with
  it, to the dispatcher, who passes them on, or straight to the teammate. A card in To do lists them on its page, where
  one can be taken off. If a file is moved or deleted before the card starts, the card stays in To do and says which;
  a card that waits for others says so on the board too, and tries again as soon as you save it. See
  [The board](README.en.md#the-board-every-request-as-a-card-filed-under-projects).
- **Moving bots between teams asks first.** When a new team takes bots that are in other teams, the panel lists them,
  the team each comes from and whether it leads it, before the team is made; go back and nothing moves. See
  [Hire a whole team in one click](README.en.md#hire-a-whole-team-in-one-click).

## 0.19.0 — 2026-11-26

- **Find a card on the board.** Below the project chips, filter the cards by when they were filed (**Today**, **This
  week**, **This month**, **Last month**, or **Custom** days, the last one included) and search their numbers, titles
  and descriptions. The filters work together and with the project, and reach every card, however old; with more cards
  than one page holds, **Load more** fetches the next ones.
- **Archive what is finished.** A card that is done or dropped has **Archive** on its page: it leaves the board and
  waits under **Archived**, with its number, tasks and results, where it is searched the same way and **Restore**d.
  Archived cards are never pruned; a follow-up on one, or starting it again, puts it back on the board. See
  [The board](README.en.md#the-board-every-request-as-a-card-filed-under-projects).

## 0.18.1 — 2026-11-26

- **Images is featured in the app gallery, beside Open Computer Use.** Its card at the top of a bot's **Apps** page
  says whether this Harness has the Images plugin (`@kadaliao/dsh-images`), and **Install now** installs it through
  Harness's plugin manager; a card that says **Turned off** switches it back on. One install serves every bot, and
  **Add** turns drawing back on for a bot that has it off. Then choose the image model in the **Images** panel, under
  **Settings**. See [Images](README.en.md#images).

## 0.18.0 — 2026-11-26

- **Point a bot at files.** A file button beside the image button, in a bot's chat, a thread and a task, references
  up to ten files of your computer: search the folder the conversation works in, paste a full path (`/…`, `~/…`) to
  look elsewhere, or click **Another folder…**. The bot gets each file's full path and reads it with its own file
  tools, so nothing is uploaded or copied, and work it hands on takes the references along. Messages and tasks keep
  the full paths of the files they reference. See [The chat](README.en.md#the-chat-reply-to-a-message-to-open-a-thread).

## 0.17.6 — 2026-11-25

- **Bots checks for a new version when you open its panel, not on a timer.** It asks about Bots only, at most once a
  minute, and a new version shows as a bar across the top of the panel: **Update**, **Later** or **Skip this
  version**. Harness closes the panel while it replaces Bots; the panel opens again by itself and says how the update
  went. See [Updates](README.en.md#updates).
- The bottom-right card from 0.17.3, one for all `@kadaliao/dsh-*` plugins, goes away once every plugin that shows it
  is updated (Archify 0.4.2, Atlas 0.1.6, Images 0.5.8, Prompt EN 0.2.3 or later).

## 0.17.5 — 2026-11-25

- **A short message keeps what you said.** A brief exchange ("I merged it myself, drop it" → "Noted, that one is
  closed") gets no summary from the model, only a line in the bot's journal, and that line held the list of open
  needs sent before your message instead of your words. Once the conversation moved to a new topic, the bot no
  longer knew you had settled it, and the next morning's brief asked again. The line now holds what you said and
  what the bot answered.
- A task started from a chat app or after the open needs is titled by your words, in the usage view and the topic
  history too, not by the chat's header or the open needs.

## 0.17.4 — 2026-11-24

- **A chat no longer hears about other tasks.** When one task finished in its own chat and another failed in a Feishu
  topic, the dispatcher's answer in that topic spoke of both. The note it gets about a finished task now asks it to
  leave that task out of later answers, and a failed, stalled or reported task names the chat it came from, where
  only that task belongs.
- **News of a task from no chat stays in the panel.** A task with no chat of its own (a scheduled run with nowhere to
  report, say) whose report came in the same turn as a chat message sent the whole answer into that chat. It counts
  as the panel now: the chat gets its own answer with `bot_reply`, the rest stays in the panel, and a task opened in
  such a turn has to say which one it is for (`thread`: the chat, or `panel`).
- Plain text left over from a turn with the panel and a chat shows in the panel as the panel's answer once the chat
  has its answer; it used to be hidden.
- **Feishu images reach the bot.** An image message, and the images in a rich-text post, used to be dropped. The bot
  sees them now, like images attached in the panel, and the work it hands out carries them. An image it cannot read
  (no permission, over 20 MB) is left out and logged.
- Keenable Search is in the app catalog.

## 0.17.3 — 2026-11-24

- **Tells you when a new version is out.** A card in the bottom-right corner, one for all installed `@kadaliao/dsh-*`
  plugins; **Update** has Harness install the new version and puts the old one back if that fails. See
  [Updates](README.en.md#updates).

## 0.17.2 — 2026-11-23

- A message the dispatcher adds to a task it opened earlier shows in the chat as its own words marked **Added**, not
  as the task a second time.
- **Tool approvals in the panel.** When a bot or a task waits for Harness to approve a tool, the panel shows it with
  **Allow once** and **Reject**; the task says it waits for your approval, and the watchdog leaves it alone.
- **Add from Magpie**: the skills of Magpie's library on this machine, linked rather than copied.
- A task with no project works in its bot's own workspace.

## 0.17.1 — 2026-11-21

- After a restart, only tasks that were already working are taken up again.

## 0.17.0 — 2026-11-21

- **Images in the chat.** Attach, paste or drop images in a bot's chat, a thread or a task; the bot sees them, and work
  it hands on takes them along. `bot_send_message` takes `images`. See
  [The chat](README.en.md#the-chat-reply-to-a-message-to-open-a-thread).
- **Your own teams.** Make a team with your own name, description, colour and lead, or rename a hired one. See
  [Hire a whole team](README.en.md#hire-a-whole-team-in-one-click).
- **Team memory consolidation works on models that route by conversation** (OpenCode Go answered **Consolidate
  now** with `400 MissingSessionID`). Each consolidation call names a conversation of its own now.
- **With Harness's sidebar collapsed**, the window buttons no longer sit over the Bots title and the **New bot** button.

## 0.16.2 — 2026-11-21

- **Feishu messages come with their chat context.** To use it, add the permission `im:message:readonly` to your Feishu
  app (and `im:message.group_msg` for the earlier messages of a topic, a sensitive scope an admin approves), then
  publish a new version of the app in the developer console. Until then messages arrive as before, and the Harness log
  says once which permission is missing. See [Feishu / Lark](README.en.md#feishu--lark).
- Chat history forwarded to the bot in a private chat is read now; it used to be dropped without a word.
- Tasks opened from now on keep the chat message they came from (any chat app); tasks opened before stay as they were.

## 0.16.1 — 2026-11-19

- **A turn that fails says so.** When a bot's answer fails after Harness's retries (the model gateway down, say), a
  notice takes its place in the panel and in the chat it was for; the chat used to go quiet.
- **The rail fits many teams.** A team folds to one line, and the views below the list are one-line tiles, two to a
  line.

## 0.16.0 — 2026-11-19

- **Every team has a lead, listed first.** The one-person company gets a fifth bot, **Compass** (operations): it keeps
  the week's plan (`plan.md`), hands each part to the role that fits, and runs the team's inbox sweep, weekly
  numbers and market pulse. A one-person company you hired before is offered Compass once in the panel: **Add**
  hires it with those routines and removes your dispatcher's copies still as hired (an edited one stays, and the
  dispatcher hands its work to Compass); **No thanks** is not asked again. The content studio lists Quill first.
- Quill is **Quill 主编** and Memo **Memo 主笔** in Chinese, where the name is still as hired.
- **Teams for your own bots**: **Team** in **New bot** and on the **Profile**.
- **Memory**: shared notes, project memory, and a last day on dated notes. Nothing to migrate: your notes stay
  shared, and the nightly consolidation is told to move a note about one project into it and to drop notes that only
  record the state of work. Review **Team memory** once and delete what is out of date.
- **Projects**: **Choose folder…** for the folder; the GitHub repository may be on GitHub Enterprise.
- **GitHub Issues** watches a GitHub Enterprise server when its repositories are written as their addresses (one
  server per app).

## 0.15.0 — 2026-11-19

0.12, 0.13 and 0.14 were not published on their own: they came with this version.

- **Team leads.** The dispatcher hands a team's work to the bot that leads it, and the lead answers you once.
- Teams hired since 0.11.1 get their lead at the first start: Builder in the software squad, Quill in the content
  studio, Memo in the research desk (the bot with that handle). Taking it away on the bot's Profile sticks.
- Builder's persona and bio, and the content studio's **Plan this week** task, take their new words where they still
  read as hired; ones you edited stay as they are.

## 0.14.0 — 2026-11-19

- **Hand work out from GitHub issues.** A labelled issue becomes a card, and comments go both ways. Nothing to
  migrate: GitHub Issues is a new app, and projects have a new **GitHub repository** field.
- The board's four columns share the window's width.
- A `done` report that comes while your message to the task waits unread keeps the task open, so that message is
  answered too.
- A card you hand to a bot on the board reads on its task as asked by you.

## 0.13.0 — 2026-11-19

- **Name a card in a message to reach it.** A message that starts with a card's reference (`OPC-12 …`) goes to that
  card's task when it has one; to ask the dispatcher about the card instead, put the reference later in the message.
- **Cards that wait for others**: **Starts after** on the page of a card in To do.

## 0.12.0 — 2026-11-19

- **The board.** **Requests** is a board now: the same requests, in columns (To do, In progress, Waiting for you,
  Done) instead of groups. Nothing to migrate: your requests stay as they were, under no project, without numbers.
- **Projects.** Make them with **Projects** on the board when you want cards numbered and their tasks working in a
  folder; the dispatcher sees them at its next step. Requests from before can be filed under one from their page.
  Tasks under way keep working where they started; a task opened after you give a project a folder works there.
- File a card yourself from the board.

## 0.11.1 — 2026-11-19

- **Every team joins the one dispatcher.** Team templates have no lead any more (0.16 brought leads back), and teams
  you hired are brought along at the first start. Only what still reads exactly as it was hired changes; a persona,
  bio or scheduled task you edited stays as it is:
  - a lead that is your dispatcher (Atlas, Lead, Editor or Desk) keeps its name and becomes the front desk: its persona
    and bio are the dispatcher's, the skills of its lead role go, and an app of that role (Lead's GitHub) is turned
    off, its keys kept;
  - members get their current persona and bio (Forge asks you itself, Builder has Tester and Review check its change,
    Quill keeps the calendar…);
  - the team's routine (morning brief, weekly review, inbox sweep, numbers, market pulse, topic planning) is the
    dispatcher's, at the times it had; one the dispatcher already has by that name is not added twice.
- A lead that is not your dispatcher would only pass its messages on: the panel names it once and offers to remove it
  (its teammates stay, its routine is already the dispatcher's).
- New members and skills (the research desk's Memo, Builder's GitHub, Echo's deep-research) come when you hire the
  team again, which updates the members you have, their personas included.
- Hiring no longer asks whether the team's lead becomes the dispatcher: the team joins the one you have.

## 0.11.0 — 2026-11-18

- **Requests.** Everything you asked for is listed with how far it got. Nothing to do: 0.11 adds `needs.json` for
  them. Tasks from before the upgrade belong to no request; when you follow one up in a chat, your words name a
  request for it.
- **One way for the dispatcher to work.** Hands-on mode is gone, and there is no mode to pick: with a teammate the
  dispatcher routes, on its own it does the work itself. A team that had picked Hands-on switches to routing and sees
  the notice once; turn on the small jobs you want the dispatcher to do itself under its **Abilities**.
- **No empty answers.** With models that follow the prompt to the letter (GPT, say), the occasional `returned a
  completed response with no content` (a bot answered with nothing after a report, and its task failed) is gone.

## 0.10.2 — 2026-11-18

- Memory notes and the nightly digest are written in the language you write to the bots in.
- A consolidation may answer at greater length: a thinking model used to spend it all on reasoning and come back empty.
- The package lives in its own repository, [kadaliao/dsh-bots](https://github.com/kadaliao/dsh-bots).

## 0.10.1 — 2026-11-18

- The dispatcher puts no question cards to you, so it keeps answering: "ask me first" goes to the teammate with the
  work, and what the dispatcher must know itself it asks in a line of its reply.
- A teammate's message to the dispatcher goes into its conversation instead of opening a task for it.
- A note about a task that comes while the dispatcher is working waits for its turn to end, so it is not answered to
  you.

## 0.10.0 — 2026-11-17

- **Threads.** Replies quote what they answer, and each is answered in a thread forked at that message: it sees what
  came before, and nothing said in the main chat since. In a chat app, replying to one of the bot's messages makes a
  thread for messages sent since this version.
- The dispatcher no longer hands work to itself: work that needs a tool it does not have goes to a teammate.
- **Quit and reopen Harness** once after the upgrade. A page reload alone gives you the new page while Harness still
  runs the old Bots, and replies don't land in threads; a banner at the top of the panel says so until you reopen it.
- Nothing else to do: bots, tasks, memory, schedules, chat apps and pairings stay as they are; 0.10 adds
  `discussions.json` for threads.
- The messages of 0.9's topics show in the chat in the order they were said, with a link to each topic's thread under
  its first message; in one with a live task, what you write there still goes to the task.
- Messages from before the upgrade can be replied to: Bots finds the message's place in the conversation's log by its
  time and forks there. When it cannot (a very long conversation, or one that is gone), it forks at the
  conversation's latest turn and tells the bot that the chat may have gone on past that message.
- Threads use Harness's session fork; on a Harness without it, a reply says to update Harness first.

## 0.9.0 — 2026-11-17

- **The panel chat in topics**: every message is a topic, or joins one, and shows at once.
- **A task answers you itself**, in the topic or chat its request came from.
- Nothing to do: bots, tasks, memory, schedules, chat apps and pairings stay as they are. The timeline in
  `messages.jsonl` gains fields for topics; older messages stay in the main timeline.
- A task opened before the upgrade that came from a chat or the panel now answers the person itself when it
  reports, like new ones.
- The dispatcher in **Router** mode loses web search in its own conversation (it hands searches to a task); **Turn back
  on** under its **Abilities** gives it back.

## 0.8.0 — 2026-11-17

- **Tasks**: each piece of work handed out runs in a conversation of its own, and the dispatcher routes the work
  instead of doing it. Chat threads route to their tasks; `bot_reply`, `bot_recall` and `bot_ticket`; a watchdog for
  stuck tasks; tasks pick up after a restart. A bot's question shows as a card in the panel. Bots draw their own
  avatars.
- Bots, memory, scheduled tasks, topics, chat apps and pairings stay as they are. 0.8 adds `tickets.json` for tasks.
- A team that already had bots switches to **Router**: the dispatcher stops doing work itself and loses the
  tools listed under [The dispatcher as a router](README.en.md#the-dispatcher-as-a-router) in its own conversation, and
  work handed from one bot to another becomes a task. The Bots panel says so once, with **Open its profile** and
  **Got it**; the notice waits until the team has a bot besides the dispatcher. (From 0.8 to 0.10 the dispatcher's
  **Profile** could switch **How it works** back to **Hands-on**; 0.11 has no such choice.)
- Replies to chat apps follow the request they answer ([Chats and threads](README.en.md#chats-and-threads)); in 0.7 they
  went to the chat of the latest request.
- Thread history starts here: messages from before the upgrade belong to no thread, so reading a chat thread with
  `bot_recall` shows only what was said there since.
- In **Usage**, what 0.7 called tasks are runs now (**Runs**, **Recent runs**), with the same numbers. **By task**
  starts with the first task after the upgrade.

## 0.7.1 — 2026-11-17

- Dollar amounts stay amounts in bot replies (`$9 … $90` no longer reads as a formula).

## 0.7.0 — 2026-11-16

- Each bot on its own model, a usage view, topics that keep conversations from growing forever, and memory.

## 0.6.1 — 2026-11-16

- Up to 50 skills on at once, up to 200 kept.

## 0.6.0 — 2026-11-16

0.5.0 was not published on its own: it came with this version.

- Message the team from Feishu / Lark and Slack too.

## 0.5.0 — 2026-11-16

- Add skills from a local folder; no duplicate skills; the list of Harness skills scrolls.

## 0.4.0 — 2026-11-16

- Message the team from Telegram or Discord; apps show their logos.

## 0.3.0 – 0.3.3 — 2026-11-15

- The first release: Grok-style bot teams that message each other. Later patches kept the descriptions of a hired
  team's Harness skills and gave the robot in the icon a smile.
