import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bots-images-'));
const { apply } = await import('../index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Harness stand-in shaped like 0.2.2's Agent: `inbox.{nextTurn, nextStep}`, `followup` / `steer` /
 * `inject` / `cancel`, scoped `tools.restrict` and `tools.guard`, and a `step` driver that, like the
 * Harness, assembles the system prompt before it reports the step's `user/message` events.
 */
function fakeHarness() {
  const listeners = {};
  const tools = new Map();
  const agentsById = new Map();
  const archived = [];
  const renamed = [];
  const web = [];
  const emit = (n, ...a) => (listeners[n] ?? []).forEach((fn) => fn(...a));
  let seq = 0;
  const makeAgent = (sessionId) => {
    const sections = new Map();
    const restricts = [];
    const guards = [];
    const agent = {
      id: sessionId,
      status: 'idle',
      session: { id: sessionId },
      inbox: { nextTurn: [], nextStep: [] },
      deliveries: [],
      injected: [],
      cancels: [],
      prompts: [],
      selected: null,
      followup(m) {
        agent.inbox.nextTurn.push(m);
        agent.deliveries.push({ mode: 'followup', message: m });
      },
      steer(m) {
        agent.inbox.nextStep.push(m);
        agent.deliveries.push({ mode: 'steer', message: m });
      },
      inject(m) {
        agent.injected.push(m);
        agent.deliveries.push({ mode: 'inject', message: m });
      },
      cancel(cause, options) {
        agent.cancels.push({ cause, options });
      },
      model: {
        select(sel) {
          agent.selected = sel;
        },
        current: () => agent.selected ?? undefined,
      },
      sections,
      restricts,
      guards,
      ctx: {
        get(name) {
          if (name === 'systemPrompt') return { section: (s) => (sections.set(s.name, s), () => sections.delete(s.name)) };
          if (name === 'tools') {
            return {
              restrict: (f) => (restricts.push(f), () => restricts.splice(restricts.indexOf(f), 1)),
              guard: (g) => (guards.push(g), () => guards.splice(guards.indexOf(g), 1)),
            };
          }
          return undefined;
        },
      },
    };
    return agent;
  };
  // Harness's attachment store (dsh-attachment): admits base64 images, reads them back by reference.
  const stored = new Map();
  const services = {
    attachments: {
      async admitPromptContent(content) {
        return content.map((part) => {
          if (part.type !== 'image') return part;
          if (part.mediaType === 'image/png' && !Buffer.from(part.data, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) throw Object.assign(new Error('The image bytes do not match image/png.'), { code: 'IMAGE_TYPE_MISMATCH' });
          const data = Buffer.from(part.data, 'base64');
          const attachment = { attachmentId: `att${stored.size + 1}`.padEnd(12, '0'), mediaType: part.mediaType, bytes: data.length, width: 640, height: 480, ...(part.name ? { name: part.name } : {}) };
          stored.set(attachment.attachmentId, data);
          return { type: 'image', attachment };
        });
      },
      async readImage(ref) {
        if (!stored.has(ref.attachmentId)) throw new Error('missing');
        return { ref, data: new Uint8Array(stored.get(ref.attachmentId)) };
      },
    },
    agents: { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] },
    sessionController: {
      async create({ sessionId }) {
        if (agentsById.has(sessionId)) throw new Error(`session ${sessionId} exists`);
        const agent = makeAgent(sessionId);
        agentsById.set(sessionId, agent);
        for (const fn of listeners['agent/created'] ?? []) fn({ agent });
        return { sessionId };
      },
      async resolveAgent(id) {
        const a = agentsById.get(id);
        return a && !archived.includes(id) ? { agent: a } : { error: new Error('gone') };
      },
      async rename({ sessionId, title }) {
        renamed.push({ sessionId, title });
        return { title };
      },
    },
    workspaceRegistry: {
      async create() {
        return { id: 'ws-bots' };
      },
      get archivedSessionIds() {
        return archived;
      },
      async archiveSession(id) {
        archived.push(id);
      },
    },
  };
  const ctx = {
    tools: {
      register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)),
      definitions: () => ['bash', 'write', 'edit', 'read', 'read_image', 'web_search', 'job_output', 'generate_image', 'skill'].map((name) => ({ name, description: `${name}.` })),
    },
    effect(fn) {
      fn();
    },
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
    },
    get: (name) => services[name],
    inject(names, fn) {
      if (names.includes('webServer')) return fn({ webServer: { register: (r) => (web.push(r), () => {}) }, effect: (f) => f() });
      fn({ ...ctx, agents: services.agents });
    },
    logger: { warn() {}, info() {}, debug() {} },
  };

  /**
   * One turn of `sessionId`: the step takes its steering (or the next queued follow-up), the prompt
   * is assembled, then its messages are reported; tool calls run through the registered tools.
   */
  async function step(sessionId, { answer, calls = [], usage = { inputTokens: 500, outputTokens: 80 } } = {}) {
    const agent = agentsById.get(sessionId);
    const claimed = agent.inbox.nextStep.length ? agent.inbox.nextStep.splice(0) : agent.inbox.nextTurn.splice(0, 1);
    agent.status = 'running';
    emit('agent/status', { agent, status: 'running' });
    agent.prompts.push([...agent.sections.values()].map((s) => s.text?.()).join('\n'));
    const session = agent.session;
    for (const m of claimed) emit('session/event', session, { type: 'user/message', seq: ++seq, time: Date.now(), data: m });
    const results = [];
    for (const c of calls) {
      emit('session/event', session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'tool-call', name: c.name, argsRaw: JSON.stringify(c.args) }], source: { kind: 'model', provider: 'magpie', model: 'm' } }, usage } });
      results.push(await tools.get(c.name).execute(c.args, { agent }));
    }
    if (answer) emit('session/event', session, { type: 'assistant/message', seq: ++seq, time: Date.now(), data: { message: { content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'magpie', model: 'm' } }, usage } });
    emit('session/event', session, { type: 'turn/end', seq: ++seq, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    emit('agent/status', { agent, status: 'idle' });
    return results;
  }
  return { ctx, tools, agentsById, emit, step, stored, web };
}

/** A chat connector stand-in whose messages may carry images it reads when asked. */
const chats = [];
const loadConnector = async (kind) => ({
  kind,
  TEXT_LIMIT: 4096,
  createConnector(opts) {
    const c = {
      opts,
      stopped: false,
      reads: [],
      answer: [],
      async start() {
        return { id: '555', username: 'acme_team_bot', name: 'Acme' };
      },
      async stop() {
        c.stopped = true;
      },
      sent: [],
      async send(chatId, text) {
        c.sent.push({ chatId, text });
      },
      async typing() {},
      async readImages(msg) {
        c.reads.push(msg.messageId);
        return c.answer;
      },
      emit: (msg) => opts.onMessage(msg),
    };
    chats.push(c);
    return c;
  },
});

const h = fakeHarness();
const api = apply(h.ctx, {}, { prices: false, sweep: false, startupPumpMs: 5, loadConnector, complete: async () => ({ text: '{}', usage: {} }) });
const call = (name, args, sessionId) => h.tools.get(name).execute(args, sessionId ? { agent: { session: { id: sessionId } } } : {});
const atlas = () => api.store.find('atlas');
const forge = () => api.store.find('forge');
const agentOf = (sessionId) => h.agentsById.get(sessionId);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]).toString('base64');
const upload = (name = 'shot.png') => api.routes.images.post({ mediaType: 'image/png', data: `data:image/png;base64,${PNG}`, name: `/Users/me/Desktop/${name}` });
const imagesIn = (m) => m.content.filter((b) => b.type === 'image').map((b) => b.attachment.attachmentId);
const textIn = (m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
let homeSid;
let shot;

test('an image the person attaches is stored by the attachment store before the message is sent', async () => {
  api.store.save({ name: 'Forge', persona: 'You build things.', bio: 'Engineer' });
  const r = await upload();
  assert.equal(r.ok, true);
  shot = r.image;
  assert.deepEqual(Object.keys(shot).sort(), ['height', 'id', 'name', 'url', 'width']);
  assert.equal(shot.name, 'shot.png', 'the name, without the folder it came from');
  assert.equal(shot.url, `/__dsh_bots/image/${shot.id}`);
  assert.equal(shot.width, 640);
  // The store checks the bytes; a wrong type is refused with its words.
  await assert.rejects(api.routes.images.post({ mediaType: 'image/png', data: Buffer.from('not a png').toString('base64') }), /do not match/);
  await assert.rejects(api.routes.images.post({ mediaType: 'image/bmp', data: PNG }), /PNG, JPEG, WebP or GIF/);
});

test('a message with images reaches the bot as image blocks, with a line naming their ids, and the chat shows them', async () => {
  const r = await api.routes.send.post({ to: atlas().id, text: 'Why does the login page look like this?', images: [shot.id] });
  assert.equal(r.ok, true);
  homeSid = r.sessionId;
  const delivered = agentOf(homeSid).deliveries.at(-1).message;
  assert.deepEqual(imagesIn(delivered), [shot.id]);
  assert.equal(delivered.content.find((b) => b.type === 'image').attachment.mediaType, 'image/png');
  assert.match(textIn(delivered), /Why does the login page look like this\?/);
  assert.match(textIn(delivered), new RegExp(`\\[Image attached: ${shot.id} \\(shot\\.png\\)\\. To pass it on to a teammate, name its id in \`images\`\\.\\]`));
  assert.deepEqual(r.message.images, [shot]);
  const listed = api.routes.messages.get(new URL(`http://x/?bot=${atlas().id}`));
  const items = listed.items ?? listed.messages ?? listed;
  assert.deepEqual(items.find((m) => m.id === r.message.id).images, [shot]);
});

test('images alone are a message; nothing at all is not; an image nobody sent is refused', async () => {
  await assert.rejects(api.routes.send.post({ to: atlas().id, text: '  ' }), /must not be empty/);
  await assert.rejects(api.routes.send.post({ to: atlas().id, text: 'look', images: ['nosuchimage1'] }), /no image nosuchimage1/);
  const two = (await upload('second.png')).image;
  const r = await api.routes.send.post({ to: atlas().id, text: '', images: [two.id] });
  assert.equal(r.ok, true);
  assert.equal(r.message.text, '');
  assert.deepEqual(r.message.images.map((i) => i.id), [two.id]);
});

test('the dispatcher hands the work on: the task carries the images of the turn by itself, and its assignment shows them', async () => {
  // The turn takes both messages (the router steers backlog in together).
  const [r] = await h.step(homeSid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix the login page layout.' } }] });
  assert.equal(r.ok, true);
  assert.match(r.text, /It carries 2 images\./);
  const t = api.tickets.get(r.ticket.id);
  assert.equal(t.images.length, 2);
  assert.equal(t.images[0], shot.id);
  const first = agentOf(t.sessionId).deliveries[0].message;
  assert.deepEqual(imagesIn(first), t.images);
  assert.match(textIn(first), /2 images attached/);
  const view = api.ticketView(t);
  assert.deepEqual(view.images.map((i) => i.id), t.images);
  // The panel shows the images on the delegation too.
  const dm = api.store.messages({ bot: forge().id }).find((m) => m.ticket === t.id && m.kind === 'dm');
  assert.deepEqual(dm.images, t.images);

  // A sub-task opened from the task carries the task's images; `images: []` sends none.
  api.store.save({ name: 'Scout', persona: 'You research.', bio: 'Researcher' });
  const [sub] = await h.step(t.sessionId, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Find which browsers break this layout.' } }] });
  assert.deepEqual(api.tickets.get(sub.ticket.id).images, t.images);
  const [none] = await h.step(t.sessionId, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'And check the docs.', images: [] } }] });
  assert.equal(api.tickets.get(none.ticket.id).images, undefined);
  assert.doesNotMatch(none.text, /carries/);
});

test('a bot names the images it passes on; one it was never sent is refused', async () => {
  const third = (await upload('third.png')).image;
  await api.routes.send.post({ to: atlas().id, text: 'And this one', images: [third.id] });
  const [r] = await h.step(homeSid, { calls: [{ name: 'bot_send_message', args: { to: '@scout', text: 'Compare with the first screenshot.', images: [shot.id] } }] });
  assert.deepEqual(api.tickets.get(r.ticket.id).images, [shot.id], 'only the image it named');
  await assert.rejects(call('bot_send_message', { to: '@scout', text: 'x', images: ['madeupimage9'] }, homeSid), /no image madeupimage9/);
});

test('the person writes to a task with an image: a started task gets it in its conversation', async () => {
  const t = api.tickets.list().find((x) => x.botId === forge().id);
  const four = (await upload('four.png')).image;
  await api.request('POST', `/__dsh_bots/tickets/${t.id}/message`, { text: 'Here it is on mobile', images: [four.id] });
  const last = agentOf(t.sessionId).deliveries.at(-1).message;
  assert.deepEqual(imagesIn(last), [four.id]);
  assert.match(textIn(last), /Here it is on mobile/);
});

test('a chat message\'s images reach the bot like the panel\'s: stored, after its words, shown in the chat, and passed on with the work', async () => {
  const until = async (ok) => {
    for (let i = 0; i < 400 && !ok(); i += 1) await sleep(5);
    assert.ok(ok());
  };
  api.routes.save.post({ bot: { id: atlas().id, apps: [{ template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: '123456789:AAHimages-test-token-value' } }] } });
  const appId = api.store.get(atlas().id).apps.find((a) => a.template === 'telegram').id;
  await until(() => api.channels.view(api.store.get(atlas().id))[appId]?.state === 'connected');
  const c = chats.find((x) => !x.stopped);
  const { code } = await api.routes['channels/code'].post({ botId: atlas().id, appId });
  c.emit({ chatId: '42', messageId: '1', userId: '42', userName: 'Kada', text: `/start ${code}`, isDirect: true, mentioned: true });
  await until(() => c.sent.length > 0);
  // Two images came; the attachment store refuses the second (its bytes are no PNG): the first goes on.
  c.answer = [
    { mediaType: 'image/png', data: new Uint8Array(Buffer.from(PNG, 'base64')) },
    { mediaType: 'image/png', data: new Uint8Array(Buffer.from('not a png')) },
  ];
  c.emit({ chatId: '42', messageId: '2', userId: '42', userName: 'Kada', text: 'Why is checkout broken?\n[image]\n[image]', isDirect: true, mentioned: true, images: ['k1', 'k2'] });
  const sid = atlas().sessionId;
  await until(() => /checkout/.test(textIn(agentOf(sid).deliveries.at(-1).message)));
  assert.deepEqual(c.reads, ['2']);
  const delivered = agentOf(sid).deliveries.at(-1).message;
  const [id] = imagesIn(delivered);
  assert.equal(imagesIn(delivered).length, 1);
  assert.match(textIn(delivered), /\[Telegram · Kada\]/);
  assert.match(textIn(delivered), /Why is checkout broken\?\n\[image\]\n\[image\]/, 'the words keep where the images were');
  assert.match(textIn(delivered), new RegExp(`\\[Image attached: ${id}\\.`));
  // The turn takes it: the chat shows the image, and the work handed out carries it.
  const [r] = await h.step(sid, { calls: [{ name: 'bot_send_message', args: { to: '@forge', text: 'Fix checkout.' } }] });
  const shown = api.store.messages({ bot: atlas().id }).find((m) => m.via === 'telegram' && /checkout/.test(m.text));
  assert.deepEqual(shown.images, [id]);
  assert.match(r.text, /It carries an image\./);
  assert.deepEqual(api.tickets.get(r.ticket.id).images, [id]);
});

test('the image route serves the bytes the attachment store verified, and only images a message named', async () => {
  const route = h.web.find((r) => r.path === '/__dsh_bots/image');
  const serve = (path) =>
    new Promise((resolve) => {
      const res = { headers: {}, statusCode: 0, setHeader: (k, v) => (res.headers[k] = v), end: (body) => resolve({ ...res, body }) };
      route.handler({ method: 'GET', url: path }, res);
    });
  const ok = await serve(`/__dsh_bots/image/${shot.id}`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(ok.body), Buffer.from(PNG, 'base64'));
  assert.equal((await serve('/__dsh_bots/image/unknown00000')).statusCode, 404);
});
