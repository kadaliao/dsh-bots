import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'client.js'), 'utf8');
const allHooks = [];
afterEach(() => {
  for (const hooks of allHooks.splice(0)) hooks.runCleanups();
  delete globalThis.fetch;
});

/** A hook-capable stand-in for React that renders plain element trees. */
function fakeReact() {
  let slots = [];
  let cursor = 0;
  const hooks = {
    reset() {
      slots = [];
      cursor = 0;
    },
    rewind() {
      cursor = 0;
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      };
      return [slots[index], set];
    },
    cleanups: [],
    useEffect(effect, deps) {
      const index = cursor++;
      const last = slots[index];
      if (last !== undefined && deps !== undefined && deps.length === last.length && deps.every((d, i) => Object.is(d, last[i]))) return;
      slots[index] = deps ?? [];
      const cleanup = effect();
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup);
    },
    runCleanups() {
      for (const cleanup of hooks.cleanups.splice(0)) cleanup();
    },
  };
  const createElement = (type, props, ...children) => {
    const kids = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
    if (typeof type === 'function') {
      // A different component (or key) at this position is a remount: drop the stale hook slots after it.
      const index = cursor++;
      const mark = { type, key: props?.key };
      const last = slots[index];
      if (last && (last.type !== type || last.key !== mark.key)) slots.length = index;
      slots[index] = mark;
      return type({ ...(props ?? {}), ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) });
    }
    return { type, props: props ?? {}, children: kids };
  };
  allHooks.push(hooks);
  return { React: { createElement, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }, hooks };
}

async function loadClient({ primitives } = {}) {
  const { React, hooks } = fakeReact();
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: make }) {
        assert.equal(id, '@kadaliao/dsh-bots');
        factory = make;
      },
    },
  };
  new Function('source', `${source}\n//# sourceURL=client.js`)(source);
  const exports = factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives) return primitives;
    throw new Error(`unexpected require ${name}`);
  });
  return { exports, hooks };
}

function fakeContext({ services = {} } = {}) {
  const seen = { slots: [], locale: null, decorations: [], selected: [], opened: [] };
  const all = {
    layout: { selectPanel: (id) => seen.selected.push(id) },
    uiWorkspace: { openSession: (id) => seen.opened.push(id) },
    ...services,
  };
  const ctx = {
    get: (name) => all[name],
    inject(names, callback) {
      seen.injected = [...(seen.injected ?? []), ...names];
      callback({
        effect: (fn) => fn(),
        commandUi: {
          decorate(decoration) {
            seen.decorations.push(decoration);
            return () => {};
          },
        },
      });
    },
    effect: (fn) => fn(),
    locale: {
      register(ns, dict) {
        seen.locale = { ns, dict };
        return () => {};
      },
    },
    slots: {
      inject: (_key, callback) => callback(),
      register(options, component) {
        seen.slots.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, seen };
}

function collect(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  for (const child of node.children ?? []) collect(child, out);
  return out;
}
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOTS = [
  { id: 'bot-a', name: 'Ada', handle: 'ada', role: 'primary', avatar: { kind: 'initials', color: '#7c5cff' }, bio: 'Dispatches work', persona: 'You are Ada.', skills: [{ id: 's1', name: 'weekly', description: 'Weekly report', content: '# Do it', enabled: true }], apps: [], tools: { deny: ['bash'] }, model: null, sessionId: 'sess-a', status: 'running' },
  { id: 'bot-b', name: 'Bob', handle: 'bob', role: 'bot', avatar: { kind: 'image', url: '/__dsh_bots/avatar/bot-b?v=1', color: '#3b82f6' }, bio: 'Codes', persona: '', skills: [], apps: [
    { id: 'app1', template: 'mcp-stdio', name: 'Files', serverName: 'files', enabled: true, values: {}, config: { command: 'npx', args: ['-y', 'x'], env: {} } },
    { id: 'app2', template: 'tavily', name: 'Tavily Search', serverName: 'tavily', enabled: true, values: {}, config: {} },
  ], appIssues: { app2: 'Tavily Search needs: API key' }, tools: { deny: [] }, model: { provider: 'p', model: 'm' }, sessionId: 'sess-b', status: 'idle' },
  { id: 'bot-c', name: '研究员', handle: 'yj', role: 'bot', avatar: { kind: 'initials', color: '#10b981' }, bio: '', persona: '', skills: [], apps: [], appIssues: {}, tools: { deny: [] }, model: null, sessionId: null, status: 'offline' },
];
const STATE = { bots: BOTS, primaryId: 'bot-a', sessionMap: { 'sess-a': 'bot-a', 'sess-b': 'bot-b' }, messageCount: 2, version: 1 };
const CATALOG = {
  templates: [
    { id: 'open-computer-use', name: { en: 'Open Computer Use', zh: 'Open Computer Use 电脑操控' }, description: { en: 'Control your Mac.', zh: '操作 Mac。' }, category: 'computer', icon: 'OC', color: '#111827', transport: 'stdio', serverName: 'ocu', command: '/x/ocu', args: ['mcp'], runtime: 'binary', homepage: 'https://github.com/kadaliao/open-computer-use', featured: true, fields: [{ key: 'OCU_API_KEY', kind: 'secret', label: { en: 'Planner API key (optional)', zh: '规划模型 API Key（可选）' } }] },
    { id: 'fetch', name: { en: 'Fetch', zh: '网页抓取' }, description: { en: 'Fetch any URL.', zh: '抓取任意网址。' }, category: 'search', icon: 'FE', color: '#0ea5e9', transport: 'stdio', serverName: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], runtime: 'uv', homepage: 'https://example.com/fetch', featured: true },
    { id: 'tavily', name: { en: 'Tavily Search', zh: 'Tavily 搜索' }, description: { en: 'Search for agents.', zh: '为 Agent 设计的搜索。' }, category: 'search', icon: 'TV', color: '#7c3aed', transport: 'stdio', serverName: 'tavily', command: 'npx', runtime: 'node', homepage: 'https://example.com/tavily', keyUrl: 'https://app.tavily.com', fields: [{ key: 'TAVILY_API_KEY', kind: 'secret', required: true, label: { en: 'API key', zh: 'API Key' } }] },
    { id: 'filesystem', name: { en: 'Filesystem', zh: '文件系统' }, description: { en: 'Files in folders you allow.', zh: '在允许的文件夹里读写文件。' }, category: 'data', icon: 'FS', color: '#0f766e', transport: 'stdio', serverName: 'files', command: 'npx', runtime: 'node', homepage: 'https://example.com/fs', fields: [{ key: 'dirs', kind: 'path', arg: true, multi: true, required: true, label: { en: 'Allowed folders (one per line)', zh: '允许访问的文件夹（每行一个）' }, default: '/Users/x/Documents', help: { en: 'Absolute paths.', zh: '绝对路径。' } }] },
    { id: 'amap', name: { en: 'Amap', zh: '高德地图' }, description: { en: 'Maps in China.', zh: '高德地图。' }, category: 'life', icon: '高', color: '#2f6bff', transport: 'stdio', serverName: 'amap', command: 'npx', runtime: 'node', region: 'cn', homepage: 'https://lbs.amap.com', keyUrl: 'https://console.amap.com', fields: [{ key: 'AMAP_MAPS_API_KEY', kind: 'secret', required: true, label: { en: 'Web service key', zh: 'Web 服务 Key' } }] },
    { id: 'mcp-stdio', name: { en: 'Custom local server', zh: '自定义本地服务' }, description: { en: 'Any local server.', zh: '任意本地服务。' }, category: 'custom', icon: '{ }', color: '#475569', transport: 'stdio', serverName: 'tools', command: 'npx', args: ['-y', 'your-mcp-server'], homepage: 'https://modelcontextprotocol.io', custom: true },
  ],
  categories: [
    { id: 'computer', en: 'Computer & browser', zh: '电脑与浏览器' },
    { id: 'search', en: 'Search & web', zh: '搜索与网页' },
    { id: 'data', en: 'Files & data', zh: '文件与数据' },
    { id: 'life', en: 'Maps & everyday', zh: '地图与生活' },
    { id: 'custom', en: 'Custom', zh: '自定义' },
  ],
  imageGen: true,

  tools: [
    { name: 'bash', description: 'Run a command.' },
    { name: 'read', description: 'Read a file.' },
  ],
  models: [{ provider: 'p', model: 'm', label: 'P · M' }],
  skills: [{ name: 'pdf', description: 'PDF things' }],
  ocu: { installed: false, path: '/Users/x/.local/share/ocu/ocu' },
  mcp: true,
  zone: 'Asia/Singapore',
  abilities: [
    { id: 'web', name: { en: 'Web search & reading', zh: '联网搜索与阅读' }, description: { en: 'Search the web.', zh: '搜索网络。' }, tools: ['web_search', 'web_fetch'], available: ['web_search', 'web_fetch'] },
    { id: 'code', name: { en: 'Run commands & code', zh: '运行命令与代码' }, description: { en: 'Run shell commands.', zh: '执行命令。' }, tools: ['bash', 'job_list'], available: ['bash'] },
    { id: 'images', name: { en: 'Image generation', zh: 'AI 作图' }, description: { en: 'Draw.', zh: '画图。' }, tools: ['generate_image'], available: [] },
    { id: 'plugins', name: { en: 'Manage Harness plugins', zh: '管理 Harness 插件' }, description: { en: 'Plugins.', zh: '插件。' }, tools: ['plugin_manager'], available: ['plugin_manager'], risky: true },
  ],
  skillSources: [{ id: 'anthropics', repo: 'anthropics/skills', path: 'skills', name: { en: 'Anthropic skills', zh: 'Anthropic 官方技能' }, description: { en: 'Docs and design.', zh: '文档与设计。' } }],
};
const TEAMS = [
  {
    id: 'opc', name: { en: 'One-person company', zh: '一人公司' }, tagline: { en: 'Four people.', zh: '四个角色。' }, description: { en: 'For founders.', zh: '给创始人。' }, color: '#7c5cff', kickoff: { en: 'Hi, introduce the team.', zh: '你好，介绍一下团队。' },
    desk: [{ when: 'weekly 1,2,3,4,5 09:00', title: { en: 'Morning brief', zh: '早间简报' } }, { when: 'weekly 5 17:30', title: { en: 'Weekly review', zh: '周复盘' } }],
    bots: [
      { key: 'growth', handle: 'echo', name: { en: 'Echo', zh: 'Echo 增长' }, color: '#db2777', bio: { en: 'Growth & content: posts.', zh: '增长与内容：发帖。' }, skills: [{ name: 'deep-research', source: 'dsh', available: true }, { name: 'morning', source: 'dsh', available: false }], apps: [], tasks: [] },
      { key: 'builder', handle: 'forge', name: { en: 'Forge', zh: 'Forge 工程师' }, color: '#0f766e', bio: { en: 'Product engineer: builds.', zh: '产品工程师：开发。' }, skills: [{ name: 'webapp-testing', source: 'import', repo: 'anthropics/skills', available: true }], apps: [{ id: 'tavily', available: true }], tasks: [] },
    ],
  },
  { id: 'dev', name: { en: 'Software squad', zh: '研发小队' }, tagline: { en: 'Plan, build.', zh: '规划、开发。' }, description: { en: 'Ship.', zh: '交付。' }, color: '#0f766e', kickoff: { en: 'Lead: ask me.', zh: '负责人：问我。' }, bots: [] },
];
const LIBRARY = { skills: [{ name: 'deep-research', description: 'Research a topic.', source: 'user' }, { name: 'xlsx', description: 'Spreadsheets.', source: 'bundled' }, { name: 'weekly', description: 'Already there', source: 'user' }], sources: [] };
const GITHUB = { ok: true, owner: 'anthropics', repo: 'skills', ref: 'main', skills: [{ name: 'mcp-builder', description: 'Build MCP servers.', path: 'skills/mcp-builder', files: 9 }, { name: 'pdf', description: 'PDFs.', path: 'skills/pdf', files: 12 }] };
const LOCAL = { ok: true, root: '/home/me/skills', truncated: false, skills: [
  { name: 'fresh', description: 'A new one.', path: '/home/me/skills/fresh', files: 3 },
  { name: 'notes', description: 'Imported before.', path: '/home/me/skills/notes', files: 2 },
  { name: 'report', description: 'Clashes with a hand-written one.', path: '/home/me/skills/report', files: 1 },
] };
const EXTERNAL = { items: [
  { from: 'Codex', name: 'mcp-logseq', serverName: 'mcp-logseq', template: 'mcp-stdio', config: { command: 'uvx', args: ['mcp-logseq'], env: { LOGSEQ_API_TOKEN: 'lsq…' } } },
  { from: 'Codex', name: 'files', serverName: 'files', template: 'mcp-stdio', config: { command: 'npx', args: ['x'], env: {} } },
  { from: 'Claude Code', name: 'gh', serverName: 'gh', template: 'mcp-http', config: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bea…' } } },
] };
const MESSAGES = [
  { id: 'm1', from: 'user', to: 'bot-a', text: 'Plan the launch', at: Date.now() - 60_000, kind: 'user' },
  { id: 'm2', from: 'bot-a', to: 'bot-b', text: 'Please write the code', at: Date.now() - 30_000, kind: 'dm' },
  { id: 'm3', from: 'bot-a', to: 'user', text: 'Bob is on it', at: Date.now() - 10_000, kind: 'reply' },
];
const TASKS = [
  { id: 't1', botId: 'bot-a', title: 'Morning brief', prompt: 'Brief me', kind: 'schedule', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'active', timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Singapore' } }, describe: 'daily 09:00', lastDelivery: { deliveredAt: new Date(Date.now() - 86_400_000).toISOString() } },
  { id: 't2', botId: 'bot-a', title: 'Weekly', prompt: 'Report', scheduledAt: null, status: 'paused', timing: { kind: 'weekly', weekly: { time: '10:30:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] } } },
];

const DAY = 86_400_000;
const USAGE = {
  range: { name: '7d', from: Date.now() - 6 * DAY, to: Date.now() + DAY, bucket: DAY },
  totals: { tokens: 1_250_000, input: 50_000, output: 20_000, cacheRead: 1_180_000, cacheWrite: 0, calls: 42, cost: { USD: 1.234 }, unpriced: 3000, tasks: 7, cacheRate: 0.95 },
  prev: { tokens: 1_000_000, calls: 30, cost: {}, unpriced: 0, tasks: 5 },
  series: Array.from({ length: 7 }, (_, i) => ({ t: Date.now() - (6 - i) * DAY, tokens: i * 100_000, byBot: { 'bot-a': i * 60_000, 'bot-b': i * 40_000 }, cost: { USD: i * 0.1 } })),
  bots: [{ bot: 'bot-a', tokens: 800_000, calls: 30, tasks: 5, cost: { USD: 1 } }, { bot: 'bot-b', tokens: 450_000, calls: 12, tasks: 2, cost: { USD: 0.234 } }],
  models: [{ provider: 'p', model: 'm', tokens: 1_247_000, calls: 40, cost: { USD: 1.234 }, priced: true }, { provider: 'q', model: 'mystery-1', tokens: 3000, calls: 2, cost: {}, priced: false }],
  kinds: [{ kind: 'chat', tokens: 1_200_000, calls: 38, cost: { USD: 1.2 } }, { kind: 'memory', tokens: 50_000, calls: 4, cost: { USD: 0.034 } }],
  schedules: [{ id: 'sch-1', title: 'Morning brief', bot: 'bot-a', runs: 3, tokens: 300_000, cost: { USD: 0.3 } }],
  tasks: [{ id: 'task-1', bot: 'bot-a', trigger: 'schedule', sched: 'sch-1', title: 'Morning brief', start: Date.now() - 3_600_000, end: Date.now() - 3_500_000, status: 'done', tokens: 100_000, calls: 5, cost: { USD: 0.1 } }, { id: 'task-2', bot: 'bot-b', trigger: 'chat', via: 'telegram', title: 'Fix the login bug', start: Date.now() - 60_000, end: null, status: 'running', tokens: 5000, calls: 1, cost: {} }],
  topTasks: [],
};
const BOT_MEMORY = {
  scope: 'bot-a',
  notes: [{ id: 'n-1', text: 'Kada prefers short answers.', kind: 'preference', source: 'auto', at: Date.now() - DAY, updated: Date.now() - DAY }, { id: 'n-2', text: 'Never email on weekends.', kind: 'lesson', source: 'user', pinned: true, at: Date.now(), updated: Date.now() }],
  journal: [{ id: 'j-1', at: Date.now() - 3_600_000, bot: 'bot-a', title: 'Morning brief', summary: 'Sent the morning brief with three items.' }],
  topic: { sessionId: 'sess-a', startedAt: Date.now() - 7_200_000, tasks: 3, lastPrompt: 45_000 },
  topics: [{ sessionId: 'sess-old', startedAt: Date.now() - 3 * DAY, endedAt: Date.now() - 2 * DAY, tasks: 9, reason: 'idle', titles: ['Plan the launch', 'Weekly review'] }],
  model: null,
  settings: { auto: true, model: null, dream: true, dreamTime: '03:00' },
};
const PROJECT_MEMORY = { scope: 'pjopc00001', project: { id: 'pjopc00001', key: 'OPC', name: 'One-person company' }, notes: [{ id: 'p-1', text: 'Pricing is in USD only.', kind: 'fact', source: 'auto', at: 1, updated: 1 }], today: '2026-11-19' };
const TEAM_MEMORY = { scope: 'team', today: '2026-11-19', projects: [{ id: 'pjopc00001', key: 'OPC', name: 'One-person company', count: 1 }, { id: 'pjweb00001', key: 'WEB', name: 'Website', count: 0 }], notes: [{ id: 't-1', text: 'The company is called Acme.', kind: 'fact', source: 'dream', at: 1, updated: 1 }, { id: 't-2', text: 'Family day on 1/1.', kind: 'fact', source: 'auto', until: '2999-01-01', at: 1, updated: 1 }, { id: 't-3', text: 'An old offer.', kind: 'fact', source: 'auto', until: '2001-01-01', at: 1, updated: 1 }], digests: [{ date: '2026-11-15', text: '## Done\nAda sent the brief.', at: 1 }], journal: BOT_MEMORY.journal, dream: { lastDate: '2026-11-16', lastAt: Date.now() - 5 * 3_600_000 }, settings: { auto: true, model: null, dream: true, dreamTime: '03:00' } };
const SOURCES = {
  writable: true,
  apis: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'],
  custom: [{ route: 'bots-local', name: 'Local', api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1', models: [{ id: 'qwen' }], keyConfigured: true }],
  logins: [
    { id: 'codex', name: 'Codex CLI', product: 'ChatGPT', found: true, account: 'k@example.com', plan: 'pro', supported: true, route: 'openai-codex', connected: false, sync: false },
    { id: 'claude-code', name: 'Claude Code', product: 'Claude', found: true, supported: false, reason: 'terms' },
  ],
};
const SETTINGS = { topics: { idleHours: 6, maxContextK: 128 }, memory: { auto: true, model: null, dream: true, dreamTime: '03:00' }, prices: {}, codex: { sync: false } };
const PRICES = { overrides: {}, list: { name: 'LiteLLM', count: 1800, fetchedAt: Date.now() }, models: [{ model: 'm', provider: 'p', price: { input: 1, output: 2, currency: 'USD', source: 'catalog' } }, { model: 'mystery-1', provider: 'q', price: null }] };

// Tasks (tickets in the Host), in the shapes of PLAN-0.8 §6.3.
const MIN = 60_000;
const ticketRow = (id, botId, stage, title, extra = {}) => ({ id, title, botId, stage, requester: { kind: 'bot', botId: 'bot-a' }, createdAt: Date.now() - 90 * MIN, updatedAt: Date.now() - 10 * MIN, ...extra });
const TICKETS = [
  ticketRow('tfailed01', 'bot-b', 'failed', 'Deploy the site', { updatedAt: Date.now() - 20 * MIN, lastReport: { status: 'blocked', preview: 'No access to the server' } }),
  ticketRow('tquestion', 'bot-b', 'question', 'Which logo do you prefer?', { via: 'telegram', updatedAt: Date.now() - 2 * MIN, lastReport: { status: 'question', preview: 'Blue or green?' } }),
  ticketRow('tstalled1', 'bot-c', 'stalled', 'Write the launch post', { requester: { kind: 'user' }, via: 'panel', updatedAt: Date.now() - 40 * MIN }),
  ticketRow('tworking1', 'bot-b', 'working', 'Fix the login bug', { via: 'slack', updatedAt: Date.now() - 5 * MIN, lastReport: { status: 'progress', preview: 'Found the cause' } }),
  ticketRow('tqueued01', 'bot-c', 'queued', 'Translate the docs', { updatedAt: Date.now() - 1 * MIN }),
  ticketRow('tdone0001', 'bot-b', 'done', 'Weekly numbers', { updatedAt: Date.now() - 60 * MIN, lastReport: { status: 'done', preview: 'Revenue up 12%' } }),
  ticketRow('tstopped1', 'bot-c', 'stopped', 'Old idea', { updatedAt: Date.now() - 300 * MIN }),
];
const TICKET_DETAIL = {
  tquestion: {
    text: 'Draw two logo options and ask Kada which one he prefers.',
    sessionId: 'ticket-tquestion',
    origin: { threadKey: 'telegram:tg:42', via: 'telegram', who: 'Kada', label: 'Telegram · Kada' },
    threads: [{ key: 'telegram:tg:42', kind: 'telegram', label: 'Telegram · Kada' }],
    parentId: 'tworking1',
    children: ['tqueued01'],
    reports: [
      { at: Date.now() - 2 * MIN, status: 'question', text: '**Blue** or green?' },
      { at: Date.now() - 30 * MIN, status: 'progress', text: 'Drafted two options.' },
    ],
    runs: [{ id: 'r1', tokens: 12_000, cost: { USD: 0.02 } }, { id: 'r2', tokens: 3_000, cost: { USD: 0.005 } }],
    // The Host's totals include the task's memory summary, outside any run.
    usage: { tokens: 16_000, calls: 4, cost: { USD: 0.03 } },
  },
  tfailed01: {
    text: 'Deploy it.',
    sessionId: 'ticket-tfailed01',
    error: 'Connection refused (3 tries).',
    origin: { threadKey: 'panel:sess-a', who: 'the user' },
    threads: [{ key: 'panel:sess-a', kind: 'panel', label: 'Panel' }],
    reports: [],
    runs: [],
    ended: { at: Date.now() - 20 * MIN, by: 'system', outcome: 'failed' },
  },
};
const ticketView = (id) => {
  const row = TICKETS.find((r) => r.id === id);
  return row ? { ...row, reports: [], threads: [], runs: [], sessionId: `ticket-${id}`, ...(TICKET_DETAIL[id] ?? {}) } : null;
};
const TICKET_AFTER = { stop: 'stopped', retry: 'working', close: 'done' };
// The person's requests (Bots 0.11), as GET /needs lists them.
const NEEDS = [
  { id: 'nwaiting1', title: 'A logo for the launch', status: 'waiting', done: 0, total: 1, waiting: ['tquestion'], bots: ['bot-b'], via: 'telegram', who: 'Kada', asked: 'Make us a logo', latest: { status: 'question', at: Date.now() - 2 * MIN, botId: 'bot-b', ticket: 'tquestion', preview: 'Blue or green?' }, createdAt: Date.now() - 50 * MIN, updatedAt: Date.now() - 2 * MIN },
  { id: 'nworking1', title: 'Q3 competitor pricing table', ref: 'OPC-1', projectId: 'pjopc00001', number: 1, status: 'working', done: 1, total: 3, failed: 1, bots: ['bot-b', 'bot-c'], via: 'panel', asked: 'Compare Q3 pricing', latest: { status: 'progress', at: Date.now() - 5 * MIN, botId: 'bot-c', ticket: 'tworking1', preview: 'Europe half done' }, createdAt: Date.now() - 90 * MIN, updatedAt: Date.now() - 5 * MIN },
  { id: 'ndone0001', title: 'Weekly numbers', status: 'done', done: 1, total: 1, bots: ['bot-b'], via: 'panel', createdAt: Date.now() - 200 * MIN, updatedAt: Date.now() - 60 * MIN, endedAt: Date.now() - 60 * MIN, latest: { status: 'done', at: Date.now() - 60 * MIN, botId: 'bot-b', ticket: 'tdone0001', preview: 'Revenue up 12%' } },
  { id: 'nstopped1', title: 'Old idea', status: 'stopped', done: 0, total: 1, bots: ['bot-c'], createdAt: Date.now() - 400 * MIN, updatedAt: Date.now() - 300 * MIN, closed: { at: Date.now() - 300 * MIN, by: 'user' } },
  // A card filed on the board for later (Bots 0.12), older than a week.
  { id: 'ntodo0001', title: 'Pricing page', ref: 'OPC-2', projectId: 'pjopc00001', number: 2, status: 'todo', after: [{ id: 'nworking1', ref: 'OPC-1', title: 'Q3 competitor pricing table', status: 'working' }], done: 0, total: 0, bots: [], via: 'board', asked: 'Pricing page', createdAt: Date.now() - 9 * 24 * 60 * MIN, updatedAt: Date.now() - 9 * 24 * 60 * MIN },
];
// The projects cards are filed under (Bots 0.12), as GET /projects lists them.
const PROJECTS = [{ id: 'pjopc00001', key: 'OPC', name: 'One-person company', brief: 'Ship weekly.', dir: '/Users/me/opc', next: 3, counts: { todo: 1, working: 1, waiting: 0, done: 0, stopped: 0 } }];
const NEED_DETAIL = {
  nwaiting1: {
    auto: true,
    asks: [{ id: 'm1', at: Date.now() - 50 * MIN, text: 'Make us a logo' }, { id: 'm2', at: Date.now() - 40 * MIN, text: 'Something calm, please' }],
    results: [],
    tickets: [TICKETS[1]],
  },
  ndone0001: { asks: [{ at: Date.now() - 200 * MIN, text: 'How did we do this week?' }], results: [{ at: Date.now() - 60 * MIN, botId: 'bot-b', ticket: 'tdone0001', text: 'Revenue up **12%**.' }], tickets: [TICKETS[5]] },
  ntodo0001: { description: 'Three tiers, yearly toggle.', asks: [{ at: Date.now() - 9 * 24 * 60 * MIN, text: 'Pricing page\n\nThree tiers, yearly toggle.', via: 'board' }], results: [], tickets: [] },
};
const needView = (id) => {
  const row = NEEDS.find((r) => r.id === id);
  return row ? { asks: [], results: [], tickets: [], ...row, ...(NEED_DETAIL[id] ?? {}) } : null;
};

function mockFetch(posts = []) {
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push({ path, body });
      if (path.endsWith('/open')) return { ok: true, json: async () => ({ ok: true, sessionId: 'sess-a' }) };
      if (path.endsWith('/teams/create') || path.endsWith('/teams/update')) return { ok: true, json: async () => ({ ok: true, team: { id: body.id ?? 'supply-chain', name: { en: body.name, zh: body.name }, tagline: { en: body.tagline, zh: body.tagline }, color: body.color, custom: true, members: body.members ?? [], lead: body.lead ?? null } }) };
      if (path.endsWith('/teams/hire')) return { ok: true, json: async () => ({ ok: true, team: body.id, bots: [BOTS[1]], dispatcherId: 'bot-a', kickoff: 'Hi, introduce the team.', skipped: [{ bot: 'echo', kind: 'skill', name: 'morning' }] }) };
      if (path.endsWith('/skills/github')) return { ok: true, json: async () => GITHUB };
      if (path.endsWith('/skills/local')) return { ok: true, json: async () => LOCAL };
      if (path.endsWith('/skills/import')) return { ok: true, json: async () => ({ ok: true, bot: BOTS[1], added: body.items.map((i) => (i.path ?? i.local).split('/').pop()), updated: [], skipped: [], failed: [] }) };
      if (path.endsWith('/skills/write')) return { ok: true, json: async () => ({ ok: true, sessionId: 'sess-b' }) };
      if (path.endsWith('/apps/import')) return { ok: true, json: async () => ({ ok: true, bot: BOTS[1], added: body.names }) };
      if (path.endsWith('/projects/save')) return { ok: true, json: async () => ({ ok: true, project: { ...PROJECTS[0], ...body.project, id: body.project.id ?? 'pjnew00001' } }) };
      if (path === '/__dsh_bots/save') return { ok: true, json: async () => ({ ok: true, bot: { ...BOTS[0], ...body.bot, id: body.bot.id ?? 'bot-new' } }) };
      if (path.endsWith('/needs/create')) return { ok: true, json: async () => ({ ok: true, ...needView('ntodo0001'), id: 'nnew00001', title: body.title, status: body.start ? 'working' : 'todo' }) };
      if (path.endsWith('/projects/delete')) return { ok: true, json: async () => ({ ok: true, cards: 2 }) };
      const needAct = /^\/__dsh_bots\/needs\/([^/]+)\/(rename|drop|start|done|save)$/.exec(path);
      if (needAct) {
        const view = needView(decodeURIComponent(needAct[1]));
        const after = { drop: { status: 'stopped' }, rename: { title: body.title }, start: { status: 'working' }, done: { status: 'done' }, save: body };
        return { ok: true, json: async () => ({ ok: true, ...view, ...after[needAct[2]] }) };
      }
      const act = /^\/__dsh_bots\/tickets\/([^/]+)\/(stop|retry|close|message)$/.exec(path);
      if (act) {
        const view = ticketView(decodeURIComponent(act[1]));
        if (!view) return { ok: false, status: 404, json: async () => null };
        return { ok: true, json: async () => (act[2] === 'message' ? { ok: true } : { ...view, stage: TICKET_AFTER[act[2]] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (path.startsWith('/__dsh_bots/needs/')) {
      const view = needView(decodeURIComponent(path.slice('/__dsh_bots/needs/'.length).split('?')[0]));
      return view ? { ok: true, json: async () => view } : { ok: false, status: 404, json: async () => null };
    }
    if (path.startsWith('/__dsh_bots/needs')) return { ok: true, json: async () => ({ items: NEEDS, next_offset: null }) };
    if (path.startsWith('/__dsh_bots/projects')) return { ok: true, json: async () => ({ items: PROJECTS }) };
    if (path.startsWith('/__dsh_bots/tickets/')) {
      const view = ticketView(decodeURIComponent(path.slice('/__dsh_bots/tickets/'.length).split('?')[0]));
      return view ? { ok: true, json: async () => view } : { ok: false, status: 404, json: async () => null };
    }
    if (path.startsWith('/__dsh_bots/tickets')) {
      const q = new URL(path, 'http://x').searchParams;
      const items = TICKETS.filter((r) => !q.get('bot') || r.botId === q.get('bot'));
      return { ok: true, json: async () => ({ items, next_offset: null }) };
    }
    if (path.startsWith('/__dsh_bots/state')) return { ok: true, json: async () => STATE };
    if (path.startsWith('/__dsh_bots/catalog')) return { ok: true, json: async () => CATALOG };
    if (path.startsWith('/__dsh_bots/messages')) return { ok: true, json: async () => ({ items: MESSAGES }) };
    if (path.startsWith('/__dsh_bots/schedules')) return { ok: true, json: async () => ({ items: TASKS }) };
    if (path.startsWith('/__dsh_bots/teams')) return { ok: true, json: async () => TEAMS };
    if (path.startsWith('/__dsh_bots/skills/local')) return { ok: true, json: async () => ({ places: [{ path: '/home/me/.claude/skills', label: '~/.claude/skills' }] }) };
    if (path.startsWith('/__dsh_bots/skills/magpie')) return { ok: true, json: async () => MAGPIE };
    if (path.startsWith('/__dsh_bots/skills/library')) return { ok: true, json: async () => LIBRARY };
    if (path.startsWith('/__dsh_bots/apps/external')) return { ok: true, json: async () => EXTERNAL };
    if (path.startsWith('/__dsh_bots/usage')) return { ok: true, json: async () => USAGE };
    if (path.startsWith('/__dsh_bots/memory')) return { ok: true, json: async () => (path.includes('bot=team') ? TEAM_MEMORY : path.includes('bot=pj') ? PROJECT_MEMORY : BOT_MEMORY) };
    if (path.startsWith('/__dsh_bots/models/sources')) return { ok: true, json: async () => SOURCES };
    if (path.startsWith('/__dsh_bots/settings')) return { ok: true, json: async () => ({ settings: SETTINGS }) };
    if (path.startsWith('/__dsh_bots/prices')) return { ok: true, json: async () => PRICES };
    return { ok: false, status: 404, json: async () => null };
  };
  return posts;
}

/** Render the panel until its fetches settle. */
async function renderSettled(component, props, hooks) {
  hooks.reset();
  component(props);
  for (let i = 0; i < 4; i += 1) {
    await flush();
    hooks.rewind();
    component(props);
  }
  await flush();
  hooks.rewind();
  return component(props);
}

test('the client registers its tool views, the panel, the badges and /bots', async () => {
  const { exports } = await loadClient();
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const names = seen.slots.map((s) => [s.options.name, s.options.key ?? s.options.id]);
  assert.deepEqual(names, [
    ['tool.call.toolview', 'bot_send_message'],
    ['tool.call.toolview', 'bot_create'],
    ['tool.call.toolview', 'bot_update'],
    ['tool.call.toolview', 'bot_delete'],
    ['tool.call.toolview', 'bot_list'],
    ['tool.call.toolview', 'bot_schedule'],
    ['sidebar.panellist', 'bots'],
    ['main', 'bots'],
    ['conversation.session.header.utilities', 'bots'],
    ['sidebar.session.row.leading', 'bots'],
  ]);
  const icon = seen.slots.find((s) => s.options.name === 'sidebar.panellist');
  assert.equal(icon.options.label(), 'Bots');
  assert.equal(icon.options.order, 31);
  assert.equal(icon.component({ size: 20, active: true }).props.width, 20);
  assert.equal(seen.locale.ns, 'bots');
  assert.deepEqual(Object.keys(seen.locale.dict.zh).sort(), Object.keys(seen.locale.dict.en).sort());
  assert.deepEqual(seen.injected, ['remote', 'remote.pluginManager', 'remoteAccess', 'layout', 'commandUi']);
  const [decoration] = seen.decorations;
  assert.equal(decoration.name, 'bots');
  assert.equal(decoration.available(), true);
  decoration.ui.run({});
  assert.deepEqual(seen.selected, ['bots']);
});

test('every literal t() key exists in both dictionaries', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const en = seen.locale.dict.en;
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z_0-9]+)'/g)].map((m) => m[1]));
  for (const key of used) assert.ok(key in en, `missing ${key}`);
  for (const prefix of ['status_running', 'status_idle', 'status_offline', 'tab_chat', 'tab_apps', 'wd1', 'wd7', 'mode_cron', 'kind_reply', 'taskStatus_ended', 'personaText_coder']) assert.ok(prefix in en, prefix);
});

test('the panel lists bots, shows the dispatcher and the chat thread, and sends a message', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const tree = await renderSettled(panel, {}, hooks);
  const text = collect(tree).join(' ');
  assert.match(text, /Ada/);
  assert.match(text, /@bob/);
  assert.match(text, /Dispatcher/);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-row']).length, 3);
  // The rail's head clears the window chrome Harness puts over the top-left corner when its sidebar is collapsed (#4).
  const [railHead] = findAll(tree, (n) => n.props['data-dsh-bots-rail-head']);
  assert.match(railHead.props.style.paddingTop, /var\(--dsh-frame-leading-clearance, 0px\)/);
  // Initials avatars: derived from the name, pinyin for a Chinese name; no emoji anywhere.
  const letters = findAll(tree, (n) => n.props['data-dsh-bots-initials']).map((n) => n.props['data-dsh-bots-initials']);
  assert.ok(letters.includes('AD'));
  assert.ok(letters.includes('YJ'));
  assert.doesNotMatch(collect(tree).join(' '), /\p{Extended_Pictographic}/u);
  // The primary bot is selected by default, on the Chat tab.
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-detail'] === 'bot-a').length === 1);
  assert.match(text, /Plan the launch/);
  assert.match(text, /Please write the code/);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-msg'] === 'dm').length >= 1);
  // Running status dot.
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-status'] === 'running').length >= 1);
  // Uploaded image avatar.
  assert.ok(findAll(tree, (n) => n.type === 'img' && n.props.src === '/__dsh_bots/avatar/bot-b?v=1').length >= 1);

  // Type and press Enter.
  const [composer] = findAll(tree, (n) => n.props['data-dsh-bots-composer']);
  composer.props.onChange({ target: { value: 'hello ada' } });
  hooks.rewind();
  const typed = panel({});
  const [box] = findAll(typed, (n) => n.props['data-dsh-bots-composer']);
  let prevented = false;
  box.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  await flush();
  assert.deepEqual(posts.find((p) => p.path.endsWith('/send'))?.body, { to: 'bot-a', text: 'hello ada' });

  // Open conversation → POST open → uiWorkspace.openSession.
  hooks.rewind();
  const again = panel({});
  const [openBtn] = findAll(again, (n) => n.props['data-dsh-bots-open'] === 'bot-a');
  openBtn.props.onClick();
  await flush();
  await flush();
  assert.ok(posts.some((p) => p.path.endsWith('/open') && p.body.id === 'bot-a'));
  assert.deepEqual(seen.opened, ['sess-a']);
  hooks.runCleanups();
});

test('images (0.17): one attached is stored at once and the message names it; a message shows its images, which open large', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const base = globalThis.fetch;
  // The Host stores the image and answers with its id; the page reads the file and previews it.
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/images') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push({ path: String(url), body });
      return { ok: true, json: async () => ({ ok: true, image: { id: 'att000000001', url: '/__dsh_bots/image/att000000001', width: 800, height: 600, name: body.name } }) };
    }
    return base(url, init);
  };
  const saved = { FileReader: globalThis.FileReader, createObjectURL: URL.createObjectURL };
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,iVBORw0KGgo=`;
      setTimeout(() => this.onload?.(), 0);
    }
  };
  URL.createObjectURL = () => 'blob:preview';
  MESSAGES.push({ id: 'm9', from: 'user', to: 'bot-a', text: '', at: Date.now() - 5_000, kind: 'user', images: [{ id: 'att000000009', url: '/__dsh_bots/image/att000000009', width: 1200, height: 900, name: 'error.png' }] });
  try {
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    let tree = await renderSettled(panel, {}, hooks);
    // A message of images alone shows them, without an empty bubble.
    const [thumb] = findAll(tree, (n) => n.props['data-dsh-bots-msg-image'] === 'att000000009');
    assert.ok(thumb, 'the image of the message');
    assert.equal(findAll(thumb, (n) => n.type === 'img')[0].props.src, '/__dsh_bots/image/att000000009');
    thumb.props.onClick({ stopPropagation() {} });
    hooks.rewind();
    tree = panel({});
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-lightbox'] === 'att000000009').length, 1, 'opened large');

    // Attach one: it is stored at once; the send button takes it without words.
    const file = { name: 'shot.png', type: 'image/png' };
    const [input] = findAll(tree, (n) => n.props['data-dsh-bots-attach-input'] === 'chat');
    input.props.onChange({ target: { files: [file, { name: 'notes.txt', type: 'text/plain' }] } });
    for (let i = 0; i < 3; i += 1) await flush();
    await new Promise((r) => setTimeout(r, 5));
    await flush();
    hooks.rewind();
    tree = panel({});
    const upload = posts.find((p) => p.path.endsWith('/images'));
    assert.deepEqual(upload.body, { mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=', name: 'shot.png' });
    assert.equal(posts.filter((p) => p.path.endsWith('/images')).length, 1, 'only the image');
    assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-attached-item']).map((n) => n.props['data-dsh-bots-attached-item']), ['ready']);
    const [sendBtn] = findAll(tree, (n) => n.props['data-dsh-bots-send']);
    assert.equal(sendBtn.props.disabled, false);
    sendBtn.props.onClick();
    await flush();
    assert.deepEqual(posts.find((p) => p.path.endsWith('/send'))?.body, { to: 'bot-a', text: '', images: ['att000000001'] });
    hooks.rewind();
    tree = panel({});
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-attached']).length, 0, 'the composer is clear again');

    // A pasted screenshot is attached too.
    const [box] = findAll(tree, (n) => n.props['data-dsh-bots-composer']);
    let prevented = false;
    box.props.onPaste({ clipboardData: { files: [{ name: 'image.png', type: 'image/png' }] }, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    await new Promise((r) => setTimeout(r, 5));
    await flush();
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-attached-item']).map((n) => n.props['data-dsh-bots-attached-item']), ['ready']);
    assert.equal(posts.filter((p) => p.path.endsWith('/images')).at(-1).body.name, 'image.png');
    hooks.runCleanups();
  } finally {
    MESSAGES.pop();
    globalThis.FileReader = saved.FileReader;
    URL.createObjectURL = saved.createObjectURL;
    globalThis.fetch = base;
  }
});

test('files: one of the conversation\'s folder is picked in the composer, shown before sending and removable, and the message references it; images still drop in', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const base = globalThis.fetch;
  const asked = [];
  // The Host lists the files of the folder the conversation works in, and stores a dropped image.
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.startsWith('/__dsh_bots/files?')) {
      asked.push(path);
      const q = new URL(path, 'http://x').searchParams.get('q');
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      const files = ['README.md', 'docs/plan.md', 'src/app.js'].filter((f) => words.every((w) => f.toLowerCase().includes(w)));
      return { ok: true, json: async () => ({ ok: true, root: '/Users/me/bots/workspace', files, truncated: false }) };
    }
    if (path.endsWith('/images') && init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true, image: { id: 'att000000001', url: '/__dsh_bots/image/att000000001', width: 800, height: 600, name: 'shot.png' } }) };
    }
    return base(url, init);
  };
  const saved = { FileReader: globalThis.FileReader, createObjectURL: URL.createObjectURL };
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,iVBORw0KGgo=`;
      setTimeout(() => this.onload?.(), 0);
    }
  };
  URL.createObjectURL = () => 'blob:preview';
  MESSAGES.push({ id: 'm8', from: 'user', to: 'bot-a', text: '', at: Date.now() - 5_000, kind: 'user', files: [{ path: '/Users/me/bots/workspace/docs/spec.md', name: 'docs/spec.md' }] });
  try {
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    const again = async (ms = 0) => {
      await new Promise((r) => setTimeout(r, ms));
      await flush();
      hooks.rewind();
      panel({});
      await flush();
      hooks.rewind();
      return panel({});
    };
    let tree = await renderSettled(panel, {}, hooks);
    // A message of references alone shows them: the file's name, its full path behind it.
    const [shown] = findAll(tree, (n) => n.props['data-dsh-bots-msg-file'] === 'docs/spec.md');
    assert.equal(shown.props.title, '/Users/me/bots/workspace/docs/spec.md');
    assert.deepEqual(collect(shown), ['spec.md']);

    // The button opens the picker, which starts in the folder the bot's conversation works in.
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-picker']).length, 0);
    findAll(tree, (n) => n.props['data-dsh-bots-file-button'] === 'chat')[0].props.onClick();
    tree = await again();
    assert.equal(asked[0], '/__dsh_bots/files?bot=bot-a&q=');
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-root'])[0].props['data-dsh-bots-file-root'], '/Users/me/bots/workspace');
    const options = (node) => findAll(node, (n) => n.props['data-dsh-bots-file-option']).map((n) => n.props['data-dsh-bots-file-option']);
    assert.deepEqual(options(tree), ['README.md', 'docs/plan.md', 'src/app.js']);
    // Typing searches by name or path.
    findAll(tree, (n) => n.props['data-dsh-bots-file-search'] === 'chat')[0].props.onChange({ target: { value: 'plan' } });
    hooks.rewind();
    panel({});
    tree = await again(230);
    assert.equal(asked.at(-1), '/__dsh_bots/files?bot=bot-a&q=plan');
    assert.deepEqual(options(tree), ['docs/plan.md']);

    // One click references the file: it shows above the box before sending, and can be removed.
    findAll(tree, (n) => n.props['data-dsh-bots-file-option'] === 'docs/plan.md')[0].props.onClick();
    hooks.rewind();
    tree = panel({});
    const chips = (node) => findAll(node, (n) => n.props['data-dsh-bots-file-ref']).map((n) => n.props['data-dsh-bots-file-ref']);
    assert.deepEqual(chips(tree), ['docs/plan.md']);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-option'] === 'docs/plan.md')[0].props.disabled, true, 'picked already');
    findAll(tree, (n) => n.props['data-dsh-bots-file-ref-remove'] === 'docs/plan.md')[0].props.onClick();
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(chips(tree), []);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-send'])[0].props.disabled, true, 'nothing to send');
    findAll(tree, (n) => n.props['data-dsh-bots-file-option'] === 'docs/plan.md')[0].props.onClick();
    hooks.rewind();
    tree = panel({});

    // References alone are a message: it names the file by its path in the conversation's folder.
    const [sendBtn] = findAll(tree, (n) => n.props['data-dsh-bots-send']);
    assert.equal(sendBtn.props.disabled, false);
    sendBtn.props.onClick();
    await flush();
    assert.deepEqual(posts.find((p) => p.path.endsWith('/send'))?.body, { to: 'bot-a', text: '', files: ['docs/plan.md'] });
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(chips(tree), [], 'the composer is clear again');
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-picker']).length, 0, 'and the picker closed');

    // An image dropped on the composer is still attached.
    const box = () => findAll(tree, (n) => n.props['data-dsh-bots-composer-box'])[0];
    const drop = (...files) => box().props.onDrop({ dataTransfer: { types: ['Files'], files }, preventDefault() {} });
    const search = () => findAll(tree, (n) => n.props['data-dsh-bots-file-search'] === 'chat')[0];
    drop({ name: 'shot.png', type: 'image/png' });
    tree = await again(5);
    assert.equal(posts.filter((p) => p.path.endsWith('/images')).length, 1);
    assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-attached-item']).map((n) => n.props['data-dsh-bots-attached-item']), ['ready']);
    assert.doesNotMatch(collect(tree).join('\n'), /can't tell where/);
    // A file that is no image, of which the page does not learn the path, opens the picker on its name: one click references it.
    drop({ name: 'plan.md', type: 'text/markdown' });
    tree = await again();
    assert.equal(posts.filter((p) => p.path.endsWith('/images')).length, 1, 'not uploaded');
    assert.match(collect(tree).join('\n'), /The panel can't tell where "plan\.md" is: click it in the list to reference it\./);
    assert.equal(search().props.value, 'plan.md');
    assert.equal(asked.at(-1), '/__dsh_bots/files?bot=bot-a&q=plan.md');
    assert.deepEqual(options(tree), ['docs/plan.md']);
    findAll(tree, (n) => n.props['data-dsh-bots-file-option'] === 'docs/plan.md')[0].props.onClick();
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(chips(tree), ['docs/plan.md']);
    // Closed, the picker opens again on an empty search.
    findAll(tree, (n) => n.props['data-dsh-bots-file-picker-close'] === 'chat')[0].props.onClick();
    hooks.rewind();
    tree = panel({});
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-picker']).length, 0);
    findAll(tree, (n) => n.props['data-dsh-bots-file-button'] === 'chat')[0].props.onClick();
    tree = await again();
    assert.equal(search().props.value, '');
    findAll(tree, (n) => n.props['data-dsh-bots-file-picker-close'] === 'chat')[0].props.onClick();
    hooks.rewind();
    tree = panel({});
    // Images and files dropped together: the image is attached, and a file whose full path the desktop shell tells is referenced by it.
    drop({ name: 'chart.png', type: 'image/png' }, { name: 'report.pdf', type: 'application/pdf', path: '/Users/me/Desktop/report.pdf' });
    tree = await again(5);
    assert.equal(posts.filter((p) => p.path.endsWith('/images')).length, 2);
    assert.deepEqual(chips(tree), ['docs/plan.md', '/Users/me/Desktop/report.pdf']);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-picker']).length, 0, 'nothing to pick');
    // A message references ten files at most.
    drop(...Array.from({ length: 10 }, (_, i) => ({ name: `n${i}.txt`, type: 'text/plain', path: `/Users/me/notes/n${i}.txt` })));
    tree = await again();
    assert.equal(chips(tree).length, 10);
    assert.deepEqual(chips(tree).slice(0, 3), ['docs/plan.md', '/Users/me/Desktop/report.pdf', '/Users/me/notes/n0.txt']);
    assert.match(collect(tree).join('\n'), /A message references at most 10 files/);
    hooks.runCleanups();
  } finally {
    MESSAGES.pop();
    globalThis.FileReader = saved.FileReader;
    URL.createObjectURL = saved.createObjectURL;
    globalThis.fetch = base;
  }
});

test('files: a bot is not tied to its folder: a pasted full path or another folder is searched, and those files are referenced by their full paths', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const base = globalThis.fetch;
  const asked = [];
  // The Host answers for the conversation's folder, for a typed full path and for a chosen folder.
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (!path.startsWith('/__dsh_bots/files?')) return base(url, init);
    asked.push(path);
    const params = new URL(path, 'http://x').searchParams;
    const answer = params.get('q').startsWith('/')
      ? { root: '/Users/me/notes/', files: ['todo.md'], elsewhere: true }
      : params.get('dir')
        ? { root: params.get('dir'), files: ['docs/spec.md', 'README.md'], elsewhere: true }
        : { root: '/Users/me/bots/workspace', files: ['README.md'], elsewhere: false };
    return { ok: true, json: async () => ({ ok: true, truncated: false, ...answer }) };
  };
  let dialog = async () => '/Users/me/code/site';
  globalThis.__DSH_DIRECTORY_PICKER__ = { pick: () => dialog() };
  try {
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    const again = async (ms = 0) => {
      await new Promise((r) => setTimeout(r, ms));
      await flush();
      hooks.rewind();
      panel({});
      await flush();
      hooks.rewind();
      return panel({});
    };
    const one = (node, attr, value) => findAll(node, (n) => (value === undefined ? n.props[attr] : n.props[attr] === value))[0];
    const options = (node) => findAll(node, (n) => n.props['data-dsh-bots-file-option']).map((n) => n.props['data-dsh-bots-file-option']);
    const chips = (node) => findAll(node, (n) => n.props['data-dsh-bots-file-ref']).map((n) => n.props['data-dsh-bots-file-ref']);
    let tree = await renderSettled(panel, {}, hooks);
    one(tree, 'data-dsh-bots-file-button', 'chat').props.onClick();
    tree = await again();
    assert.equal(one(tree, 'data-dsh-bots-file-search', 'chat').props.placeholder, 'Search by file name, or paste a full path');
    assert.equal(one(tree, 'data-dsh-bots-file-root').props['data-elsewhere'], undefined);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-dir-reset']).length, 0, 'nothing to go back from');
    one(tree, 'data-dsh-bots-file-option', 'README.md').props.onClick();
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(chips(tree), ['README.md']);

    // A full path pasted in the search box: the Host looks where it leads, and the file is referenced by its full path.
    one(tree, 'data-dsh-bots-file-search', 'chat').props.onChange({ target: { value: '/Users/me/notes/todo' } });
    hooks.rewind();
    panel({});
    tree = await again(230);
    assert.equal(asked.at(-1), `/__dsh_bots/files?bot=bot-a&q=${encodeURIComponent('/Users/me/notes/todo')}`);
    assert.equal(one(tree, 'data-dsh-bots-file-root').props['data-dsh-bots-file-root'], '/Users/me/notes/');
    assert.equal(one(tree, 'data-dsh-bots-file-root').props['data-elsewhere'], true);
    assert.equal(one(tree, 'data-dsh-bots-file-option', 'todo.md').props.title, '/Users/me/notes/todo.md');
    one(tree, 'data-dsh-bots-file-option', 'todo.md').props.onClick();
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(chips(tree), ['README.md', '/Users/me/notes/todo.md']);
    assert.deepEqual(collect(one(tree, 'data-dsh-bots-file-ref', '/Users/me/notes/todo.md')), ['todo.md'], 'shown by its name, the full path behind it');
    assert.equal(one(tree, 'data-dsh-bots-file-option', 'todo.md').props.disabled, true, 'picked already');

    // "Another folder" opens the Host's folder dialog; the picker then searches that folder.
    one(tree, 'data-dsh-bots-file-dir', 'chat').props.onClick();
    tree = await again(5);
    assert.equal(asked.at(-1), `/__dsh_bots/files?bot=bot-a&q=&dir=${encodeURIComponent('/Users/me/code/site')}`);
    assert.equal(one(tree, 'data-dsh-bots-file-search', 'chat').props.value, '', 'the typed path is cleared');
    assert.deepEqual(options(tree), ['docs/spec.md', 'README.md']);
    assert.equal(one(tree, 'data-dsh-bots-file-option', 'README.md').props.disabled, false, 'another README than the one picked');
    one(tree, 'data-dsh-bots-file-option', 'docs/spec.md').props.onClick();
    hooks.rewind();
    tree = panel({});
    assert.deepEqual(chips(tree), ['README.md', '/Users/me/notes/todo.md', '/Users/me/code/site/docs/spec.md']);
    // A dialog closed without a choice changes nothing; one that fails says so.
    dialog = async () => null;
    one(tree, 'data-dsh-bots-file-dir', 'chat').props.onClick();
    tree = await again(5);
    assert.equal(one(tree, 'data-dsh-bots-file-root').props['data-dsh-bots-file-root'], '/Users/me/code/site');
    dialog = async () => {
      throw new Error('no dialog');
    };
    one(tree, 'data-dsh-bots-file-dir', 'chat').props.onClick();
    tree = await again(5);
    assert.match(collect(tree).join('\n'), /The folder dialog is unavailable here; type or paste the path instead\./);
    // Back to the conversation's folder.
    const calls = asked.length;
    one(tree, 'data-dsh-bots-file-dir-reset', 'chat').props.onClick();
    tree = await again(5);
    assert.equal(asked.length, calls + 1);
    assert.equal(asked.at(-1), '/__dsh_bots/files?bot=bot-a&q=');
    assert.equal(one(tree, 'data-dsh-bots-file-root').props['data-dsh-bots-file-root'], '/Users/me/bots/workspace');
    assert.equal(one(tree, 'data-dsh-bots-file-option', 'README.md').props.disabled, true);

    one(tree, 'data-dsh-bots-send').props.onClick();
    await flush();
    assert.deepEqual(posts.find((p) => p.path.endsWith('/send'))?.body, { to: 'bot-a', text: '', files: ['README.md', '/Users/me/notes/todo.md', '/Users/me/code/site/docs/spec.md'] });

    // Without a folder dialog (a Host that has none) the button is not offered: a path can still be pasted.
    delete globalThis.__DSH_DIRECTORY_PICKER__;
    hooks.rewind();
    tree = panel({});
    one(tree, 'data-dsh-bots-file-button', 'chat').props.onClick();
    tree = await again();
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-picker']).length, 1);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-dir']).length, 0);
    hooks.runCleanups();
  } finally {
    delete globalThis.__DSH_DIRECTORY_PICKER__;
    globalThis.fetch = base;
  }
});

test('each tab renders: profile, skills, schedules, apps, and the activity view', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const tabTo = async (id) => {
    const [tab] = findAll(tree, (n) => n.props['data-dsh-bots-tab'] === id);
    tab.props.onClick();
    for (let i = 0; i < 3; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return collect(tree).join(' ');
  };

  let text = await tabTo('profile');
  assert.match(text, /Persona/);
  assert.match(text, /Abilities/);
  assert.match(text, /Advanced: per tool \(1 of 2 allowed\)/);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-avatar-editor']).length === 1);
  const boxes = findAll(tree, (n) => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].props.checked, false); // bash denied

  text = await tabTo('skills');
  assert.match(text, /weekly/);
  assert.match(text, /Add from Harness/);
  assert.match(text, /Import from GitHub/);
  assert.match(text, /Let the bot write it/);
  assert.match(text, /Write by hand/);

  text = await tabTo('schedules');
  assert.match(text, /Morning brief/);
  assert.match(text, /Every day 09:00 \(Asia\/Singapore\)/);
  assert.match(text, /Weekdays 10:30 \(UTC\)/);
  assert.match(text, /Next in 1 h/);
  // Create a new schedule: weekly.
  const [add] = findAll(tree, (n) => n.props['data-dsh-bots-add-schedule']);
  add.props.onClick();
  hooks.rewind();
  tree = panel({});
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-schedule-editor']).length === 1);

  text = await tabTo('apps');
  assert.match(text, /Open Computer Use/);
  assert.match(text, /Not installed/);
  assert.match(text, /Install now/);
  assert.match(text, /next time the bot’s conversation starts/);
  assert.match(text, /App gallery/);
  assert.match(text, /Featured/);
  assert.match(text, /Tavily Search/);
  assert.match(text, /China/); // the region badge on Amap
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-cat'] === 'search').length === 1);

  // Activity.
  const [act] = findAll(tree, (n) => n.props['data-dsh-bots-activity']);
  act.props.onClick();
  for (let i = 0; i < 3; i += 1) {
    hooks.rewind();
    tree = panel({});
    await flush();
  }
  hooks.rewind();
  tree = panel({});
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-timeline']).length === 1);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-event']).length === 3);
  assert.equal(posts.length, 0);
  hooks.runCleanups();
});

test('tool views render with partial args, then with the result meta', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const view = (key) => seen.slots.find((s) => s.options.name === 'tool.call.toolview' && s.options.key === key).component;

  hooks.reset();
  let tree = view('bot_send_message')({ phase: 'preparing', block: { callId: 'c1', argsRaw: '{"to":"@bob","text":"Write the co' } });
  let text = collect(tree).join(' ');
  assert.match(text, /preparing/);
  assert.match(text, /Write the co/);

  hooks.reset();
  tree = view('bot_send_message')({
    phase: 'result',
    block: { callId: 'c1', call: { argsRaw: '{"to":"@bob","text":"Write the code"}' }, content: [{ type: 'text', text: 'Delivered' }], isError: false, meta: { to: { id: 'bot-b', name: 'Bob', handle: 'bob', avatar: BOTS[1].avatar }, from: { id: 'bot-a', name: 'Ada', handle: 'ada', avatar: BOTS[0].avatar } } },
  });
  text = collect(tree).join(' ');
  assert.match(text, /Bob/);
  assert.match(text, /Ada/);
  assert.match(text, /Delivered/);

  for (const key of ['bot_create', 'bot_update', 'bot_delete']) {
    hooks.reset();
    tree = view(key)({ phase: 'running', block: { callId: 'x', argsRaw: '{"name":"Cleo","initials":"CL","bot":"@ada","bio":"x"' } });
    assert.ok(collect(tree).join(' ').length > 0);
    hooks.reset();
    tree = view(key)({ phase: 'result', block: { callId: 'x', argsRaw: '{}', isError: false, content: [], meta: { bot: { id: 'bot-z', name: 'Cleo', handle: 'cleo', avatar: { kind: 'initials', color: '#f00' }, role: 'bot' } } } });
    assert.match(collect(tree).join(' '), /Cleo/);
  }
  hooks.reset();
  tree = view('bot_list')({ phase: 'result', block: { callId: 'l', content: [], meta: { bots: [{ id: 'q', name: 'Quinn', handle: 'quinn', avatar: null, role: 'primary' }] } } });
  assert.match(collect(tree).join(' '), /Quinn/);

  hooks.reset();
  tree = view('bot_schedule')({ phase: 'running', block: { callId: 's', argsRaw: '{"action":"create","title":"Brief","kind":"weekly","time":"08:15","weekdays":[6,7],"time_zone":"UTC"}' } });
  text = collect(tree).join(' ');
  assert.match(text, /Brief/);
  assert.match(text, /Sat, Sun 08:15 \(UTC\)/);
  hooks.reset();
  tree = view('bot_schedule')({ phase: 'result', block: { callId: 's', isError: true, content: [{ type: 'text', text: 'no such task' }] } });
  assert.match(collect(tree).join(' '), /no such task/);
  hooks.runCleanups();
});

test('the header badge and the session row show the bot of a bot conversation', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const badge = seen.slots.find((s) => s.options.name === 'conversation.session.header.utilities').component;
  const row = seen.slots.find((s) => s.options.name === 'sidebar.session.row.leading').component;
  hooks.reset();
  badge({ sessionId: 'sess-b' });
  await flush();
  await flush();
  hooks.rewind();
  const tree = badge({ sessionId: 'sess-b' });
  assert.ok(tree, 'a badge for a bot session');
  assert.equal(tree.props['data-dsh-bots-badge'], 'bot-b');
  assert.match(collect(tree).join(' '), /Bob/);
  tree.props.onClick();
  assert.deepEqual(seen.selected, ['bots']);
  hooks.reset();
  assert.equal(badge({ sessionId: 'other' }), null);
  hooks.reset();
  assert.equal(row({ sessionId: 'sess-a' }).props['data-dsh-bots-row-avatar'], 'bot-a');
  hooks.runCleanups();
});

test('the panel says so when the Host is unreachable', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  const tree = await renderSettled(panel, {}, hooks);
  assert.match(collect(tree).join(' '), /not reachable/);
  hooks.runCleanups();
});

test('the client derives initials exactly like the Host, including pinyin', async () => {
  const { initialsOf } = await import('../lib/store.mjs');
  const start = source.indexOf('const PINYIN_BOUNDS');
  const end = source.indexOf('/** The letters an avatar shows');
  const clientInitials = new Function(`${source.slice(start, end)}; return initialsOf;`)();
  for (const name of ['研究员', '数据侠', '文书', '小研', 'Atlas 调度员', 'Data Scout', 'Atlas', 'DataBot', 'ada lovelace', 'x', '', 'Ölaf', '7up']) {
    assert.equal(clientInitials(name), initialsOf(name), name);
  }
  assert.equal(clientInitials('研究员'), 'YJ');
  assert.equal(clientInitials('Atlas 调度员'), 'AD');
});

test('no emoji in the client source', () => {
  const hits = [...source.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]).filter((c) => c !== '↗'); // the text arrow on external links
  assert.deepEqual(hits, []);
  assert.doesNotMatch(source, /EMOJIS|TEMPLATE_ICONS|kind: 'emoji'/);
});

/** Render the panel, pick a bot and open a tab. */
async function openTab(id, botId = 'bot-b') {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  findAll(tree, (n) => n.props['data-dsh-bots-row'] === botId)[0].props.onClick();
  await rerender();
  findAll(tree, (n) => n.props['data-dsh-bots-tab'] === id)[0].props.onClick();
  await rerender();
  return { hooks, posts, panel, get tree() { return tree; }, rerender };
}

test('apps: installed rows show the setup issue; Configure opens a form built from fields', async () => {
  const v = await openTab('apps');
  let text = collect(v.tree).join(' ');
  assert.match(text, /Tavily Search/);
  assert.match(text, /mcp__tavily__\*/);
  assert.match(text, /Needs setup/);
  assert.match(text, /Tavily Search needs: API key/);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-issue'] === 'app2').length === 1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-configure'] === 'app2')[0].props.onClick();
  await v.rerender();
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-form'] === 'tavily').length === 1);
  let [key] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'TAVILY_API_KEY');
  assert.equal(key.type, 'input');
  assert.equal(key.props.type, 'password');
  text = collect(v.tree).join(' ');
  assert.match(text, /API key/);
  assert.ok(findAll(v.tree, (n) => n.type === 'a' && n.props.href === 'https://app.tavily.com').length >= 1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0].props.disabled, true);
  findAll(v.tree, (n) => n.props['data-dsh-bots-eye'] === 'TAVILY_API_KEY')[0].props.onClick();
  await v.rerender(1);
  [key] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'TAVILY_API_KEY');
  assert.equal(key.props.type, 'text');
  key.props.onChange({ target: { value: ' tvly-123 ' } });
  await v.rerender(1);
  const save = findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0];
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await flush();
  const post = v.posts.find((p) => p.path.endsWith('/save'));
  assert.ok(post, 'saved');
  assert.equal(post.body.bot.id, 'bot-b');
  assert.equal(post.body.bot.apps.length, 2);
  assert.deepEqual(post.body.bot.apps.find((a) => a.id === 'app2').values, { TAVILY_API_KEY: 'tvly-123' });
  v.hooks.runCleanups();
});

test('apps: adding saves at once without required fields, else opens the form with defaults', async () => {
  const v = await openTab('apps');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-app'] === 'fetch')[0].props.onClick();
  await flush();
  const post = v.posts.find((p) => p.path.endsWith('/save'));
  assert.deepEqual(post.body.bot.apps.map((a) => a.template), ['mcp-stdio', 'tavily', 'fetch']);
  assert.equal(post.body.bot.apps[2].serverName, 'fetch');
  assert.deepEqual(post.body.bot.apps[2].values, {});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-app'] === 'filesystem')[0].props.onClick();
  await v.rerender(1);
  const [dirs] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'dirs');
  assert.equal(dirs.type, 'textarea');
  assert.equal(dirs.props.value, '/Users/x/Documents');
  assert.match(collect(v.tree).join(' '), /Absolute paths\./);
  dirs.props.onChange({ target: { value: '/a\n\n /b ' } });
  await v.rerender(1);
  v.posts.length = 0;
  findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0].props.onClick();
  await flush();
  const added = v.posts.find((p) => p.path.endsWith('/save')).body.bot.apps.at(-1);
  assert.equal(added.template, 'filesystem');
  assert.equal(added.serverName, 'files2'); // "files" is taken by the custom app
  assert.deepEqual(added.values, { dirs: '/a\n/b' });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-app-search'])[0].props.onChange({ target: { value: 'amap' } });
  await v.rerender(1);
  const cards = findAll(v.tree, (n) => n.props['data-dsh-bots-template']).map((n) => n.props['data-dsh-bots-template']);
  assert.deepEqual(cards, ['amap']);
  v.hooks.runCleanups();
});

test('apps: a custom server keeps the raw editor', async () => {
  const v = await openTab('apps');
  findAll(v.tree, (n) => n.props['data-dsh-bots-configure'] === 'app1')[0].props.onClick();
  await v.rerender(1);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-editor']).length === 1);
  assert.match(collect(v.tree).join(' '), /Command/);
  v.hooks.runCleanups();
});

test('profile avatar: AI generation when imageGen, clearing an image, letters, and the hint without imageGen', async () => {
  let v = await openTab('profile');
  let text = collect(v.tree).join(' ');
  assert.match(text, /Upload image/);
  assert.match(text, /Generate with AI/);
  assert.match(text, /Use letters instead/);
  assert.doesNotMatch(text, /Install the Images plugin/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-avatar-clear'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/avatar/clear')).body, { id: 'bot-b' });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-avatar-generate'])[0].props.onClick();
  await v.rerender(1);
  const [form] = findAll(v.tree, (n) => n.props['data-dsh-bots-generate-form']);
  findAll(form, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'pixel art' } });
  await v.rerender(1);
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/avatar/generate')) {
      v.posts.push({ path: String(url), body: JSON.parse(init.body) });
      await gate;
      return { ok: true, json: async () => ({ ok: true, bot: { ...BOTS[1], avatar: { kind: 'image', url: '/__dsh_bots/avatar/bot-b?v=2', color: '#3b82f6', source: 'ai' } } }) };
    }
    return realFetch(url, init);
  };
  findAll(v.tree, (n) => n.props['data-dsh-bots-generate-go'])[0].props.onClick();
  await flush();
  v.hooks.rewind();
  const busy = v.panel({});
  assert.match(collect(busy).join(' '), /Generating… \(up to a minute\)/);
  assert.equal(findAll(busy, (n) => n.props['data-dsh-bots-avatar-upload'])[0].props.disabled, true);
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/avatar/generate')).body, { id: 'bot-b', style: 'pixel art' });
  release();
  await v.rerender(2);
  assert.doesNotMatch(collect(v.tree).join(' '), /Generating…/);
  v.hooks.runCleanups();

  CATALOG.imageGen = false;
  try {
    v = await openTab('profile', 'bot-a');
    text = collect(v.tree).join(' ');
    assert.match(text, /Install the Images plugin to generate avatars with AI/);
    assert.doesNotMatch(text, /Generate with AI/);
    const [letters] = findAll(v.tree, (n) => n.props['data-dsh-bots-letters']);
    assert.equal(letters.props.placeholder, 'AD');
    letters.props.onChange({ target: { value: 'xq9' } });
    await v.rerender(1);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-letters'])[0].props.value, 'XQ');
    findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.avatar, { kind: 'initials', text: 'XQ', color: '#7c5cff' });
    v.hooks.runCleanups();
  } finally {
    CATALOG.imageGen = true;
  }
});

test('the zh dictionary has the Chinese persona templates and the imageGen hint', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const { zh } = seen.locale.dict;
  assert.equal(zh.lang, 'zh');
  assert.equal(zh.imageGenMissing, '安装「图片」插件后可用 AI 生成头像（「应用」页的推荐里可以一键安装）');
  for (const id of ['researcher', 'coder', 'writer', 'analyst', 'ops']) assert.match(zh[`personaText_${id}`], /^你是/);
  assert.equal(zh.regionCn, '中国');
});

/** Render the panel with a different roster (restored afterwards). */
async function withRoster(bots, fn) {
  const saved = STATE.bots;
  const savedPrimary = STATE.primaryId;
  STATE.bots = bots;
  STATE.primaryId = bots.find((b) => b.role === 'primary')?.id ?? null;
  try {
    return await fn();
  } finally {
    STATE.bots = saved;
    STATE.primaryId = savedPrimary;
  }
}
async function mountPanel() {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  return { hooks, posts, panel, get tree() { return tree; }, rerender };
}

test('teams: an (almost) empty roster shows the hero with team cards; details show skill chips and timing', async () => {
  await withRoster([BOTS[0]], async () => {
    const v = await mountPanel();
    let text = collect(v.tree).join(' ');
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-teams'] === 'hero').length === 1);
    assert.match(text, /Build your bot team/);
    assert.match(text, /One-person company/);
    assert.match(text, /2 bots · 3 skills · 2 scheduled tasks/);
    assert.match(text, /Growth & content/);
    // A team has no lead: no member wears the crown.
    assert.equal(findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-team'] === 'opc')[0], (n) => n.props.title === 'Dispatcher').length, 0);
    findAll(v.tree, (n) => n.props['data-dsh-bots-team-detail'] === 'opc')[0].props.onClick();
    await v.rerender(1);
    text = collect(v.tree).join(' ');
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-team-modal'] === 'opc').length === 1);
    // The dispatcher you have hands out the work and takes the routine.
    const desk = findAll(v.tree, (n) => n.props['data-dsh-bots-team-desk'] === 'bot-a')[0];
    assert.match(collect(desk).join(' '), /Ada .*Your dispatcher hands out this team's work.*Morning brief/);
    assert.match(text, /Weekdays 09:00/);
    assert.match(text, /Every Fri 17:30/);
    const morning = findAll(v.tree, (n) => n.props['data-dsh-bots-team-skill'] === 'morning')[0];
    assert.equal(morning.props['data-available'], false);
    assert.match(morning.props.title, /will be skipped/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-skill'] === 'webapp-testing')[0].props['data-source'], 'import');
    assert.match(text, /keys are filled in later/);
    v.hooks.runCleanups();
  });
});

test('teams: hiring posts {id, lang}, shows the result, and the kickoff goes to the dispatcher', async () => {
  await withRoster([{ ...BOTS[0], skills: [] }], async () => {
    const v = await mountPanel();
    findAll(v.tree, (n) => n.props['data-dsh-bots-hire'] === 'opc')[0].props.onClick();
    await v.rerender(3);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/hire')).body, { id: 'opc', lang: 'en' });
    const text = collect(v.tree).join(' ');
    assert.match(text, /One-person company is ready/);
    assert.match(text, /Hi, introduce the team\./);
    assert.match(text, /Tavily Search/); // Bob's app needs a key
    assert.match(text, /Skipped 1 items/);
    const kick = findAll(v.tree, (n) => n.props['data-dsh-bots-kickoff'] === 'bot-a')[0];
    assert.match(collect(kick).join(' '), /Send the kickoff to Ada/);
    kick.props.onClick();
    await v.rerender(2);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/send')).body, { to: 'bot-a', text: 'Hi, introduce the team.' });
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-detail'] === 'bot-a').length === 1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-tab'] === 'chat' && n.props['data-active'] === true).length === 1);
    v.hooks.runCleanups();
  });
});

test('teams: with a roster, the template list asks nothing about the dispatcher: the team joins the one you have', async () => {
  const v = await mountPanel();
  findAll(v.tree, (n) => n.props['data-dsh-bots-teams-entry'])[0].props.onClick();
  await v.rerender(1);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-teams'] === 'list').length === 1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-hire'] === 'opc')[0].props.onClick();
  await v.rerender(1);
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-hire-go']).length === 1, 'a roster confirms first');
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-hire-primary']).length, 0);
  findAll(v.tree, (n) => n.props['data-dsh-bots-hire-go'])[0].props.onClick();
  await v.rerender(3);
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/hire')).body, { id: 'opc', lang: 'en' });
  // Rail groups by team once a bot has one.
  v.hooks.runCleanups();
  await withRoster([{ ...BOTS[0], team: 'opc' }, { ...BOTS[1], team: 'opc' }, BOTS[2]], async () => {
    const w = await mountPanel();
    const groups = findAll(w.tree, (n) => n.props['data-dsh-bots-group']).map((n) => n.props['data-dsh-bots-group']);
    // The dispatcher sits on its own on top, even when it was hired with a team.
    assert.deepEqual(groups, ['desk', 'opc', 'other']);
    assert.match(collect(w.tree).join(' '), /One-person company/);
    w.hooks.runCleanups();
  });
});

test('0.16.1: a team folds to one line in the rail (its faces, who is at work, its questions); the bot you have open stays; this browser remembers', async () => {
  const kept = new Map();
  const shim = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)) };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  const dee = { ...BOTS[2], id: 'bot-d', name: 'Dee', handle: 'dee', team: 'squad', asking: 2 };
  try {
    await withRoster([BOTS[0], { ...BOTS[1], team: 'opc' }, { ...BOTS[2], team: 'opc' }, dee], async () => {
      const v = await mountPanel();
      const rowIds = () => findAll(v.tree, (n) => n.props['data-dsh-bots-row']).map((n) => n.props['data-dsh-bots-row']);
      assert.deepEqual(rowIds(), ['bot-a', 'bot-b', 'bot-c', 'bot-d']);
      // The dispatcher's group has no fold.
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-group-toggle']).map((n) => n.props['data-dsh-bots-group-toggle']), ['opc', 'squad']);
      // Open Bob, then fold his team: he stays in sight, the rest of it folds into faces.
      click(v.tree, 'data-dsh-bots-row', 'bot-b');
      await v.rerender();
      click(v.tree, 'data-dsh-bots-group-toggle', 'opc');
      await v.rerender();
      assert.deepEqual(rowIds(), ['bot-a', 'bot-b', 'bot-d']);
      const opc = findAll(v.tree, (n) => n.props['data-dsh-bots-group'] === 'opc')[0];
      assert.equal(opc.props['data-folded'], true);
      assert.equal(findAll(opc, (n) => n.props['data-dsh-bots-group-faces'])[0].props['data-dsh-bots-group-faces'], 2);
      assert.equal(findAll(opc, (n) => n.props['aria-expanded'] === false).length, 1);
      // A folded team's questions show on its header.
      click(v.tree, 'data-dsh-bots-group-toggle', 'squad');
      await v.rerender();
      assert.deepEqual(rowIds(), ['bot-a', 'bot-b']);
      const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-group-asking'] !== undefined);
      assert.equal(badge.props['data-dsh-bots-group-asking'], 2);
      assert.deepEqual(JSON.parse(kept.get('dsh-bots:rail-folded')), ['opc', 'squad']);
      v.hooks.runCleanups();
      // Opened again, the panel keeps both folded; unfolding one brings its rows back.
      const w = await mountPanel();
      assert.deepEqual(findAll(w.tree, (n) => n.props['data-folded']).map((n) => n.props['data-dsh-bots-group']), ['opc', 'squad']);
      click(w.tree, 'data-dsh-bots-group-toggle', 'squad');
      await w.rerender();
      assert.ok(findAll(w.tree, (n) => n.props['data-dsh-bots-row'] === 'bot-d').length === 1);
      assert.deepEqual(JSON.parse(kept.get('dsh-bots:rail-folded')), ['opc']);
      w.hooks.runCleanups();
    });
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete globalThis.localStorage;
  }
});

test('0.17: teams of your own — the rail shows them in their colour with an edit button, the New menu makes one, the gallery lists them, one of yours is deleted', async () => {
  const savedTeams = STATE.teams;
  STATE.teams = [
    { id: 'opc', name: { en: 'Amazon US', zh: 'Amazon US' }, tagline: { en: 'Runs the store', zh: 'Runs the store' }, color: '#10b981', template: 'opc', renamed: true, members: ['bot-b'], lead: null },
    { id: 'supply', name: { en: 'Supply', zh: 'Supply' }, tagline: { en: '', zh: '' }, color: '#64748b', custom: true, members: [], lead: null },
  ];
  try {
    await withRoster([BOTS[0], { ...BOTS[1], team: 'opc' }, BOTS[2]], async () => {
      const v = await mountPanel();
      // The rail: your name over the template's, its colour, and a team of yours with no bots yet.
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-group']).map((n) => n.props['data-dsh-bots-group']), ['desk', 'opc', 'supply', 'other']);
      const text = collect(v.tree).join(' ');
      assert.match(text, /Amazon US/);
      assert.doesNotMatch(text, /One-person company/);
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-group-color'] === '#10b981').length, 1);
      // Renamed from the rail; a hired team has no Delete.
      click(v.tree, 'data-dsh-bots-team-edit', 'opc');
      await v.rerender();
      const nameField = () => findAll(v.tree, (n) => n.props['data-dsh-bots-field'] === 'team-name')[0];
      assert.equal(nameField().props.value, 'Amazon US');
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-delete']).length, 0);
      nameField().props.onChange({ target: { value: 'Amazon US store' } });
      await v.rerender();
      click(v.tree, 'data-dsh-bots-team-save', 'opc');
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/update')).body, { id: 'opc', name: 'Amazon US store', tagline: 'Runs the store', color: '#10b981' });
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-save']).length, 0, 'closed once saved');
      // A new team from the New menu: its name, a bot in it, and that bot as its lead.
      click(v.tree, 'data-dsh-bots-new');
      await v.rerender();
      findAll(v.tree, (n) => n.props.role === 'menuitem' && collect(n).join(' ').includes('New team'))[0].props.onClick();
      await v.rerender();
      nameField().props.onChange({ target: { value: 'Supply chain' } });
      await v.rerender();
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-team-member']).map((n) => n.props['data-dsh-bots-team-member']), ['bot-b', 'bot-c'], 'never the dispatcher');
      findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-team-member'] === 'bot-c')[0], (n) => n.props.type === 'checkbox')[0].props.onChange();
      await v.rerender();
      findAll(v.tree, (n) => n.props['data-dsh-bots-team-lead'])[0].props.onChange({ target: { value: 'bot-c' } });
      click(v.tree, 'data-dsh-bots-team-color', '#ef4444');
      await v.rerender();
      click(v.tree, 'data-dsh-bots-team-save', 'new');
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/create')).body, { name: 'Supply chain', tagline: '', color: '#ef4444', members: ['bot-c'], lead: 'bot-c' });
      // The gallery lists your teams above the templates; one of yours is deleted after a confirmation.
      click(v.tree, 'data-dsh-bots-teams-entry');
      await v.rerender();
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-your-team']).map((n) => n.props['data-dsh-bots-your-team']), ['opc', 'supply']);
      click(v.tree, 'data-dsh-bots-your-team-edit', 'supply');
      await v.rerender();
      click(v.tree, 'data-dsh-bots-team-delete', 'supply');
      await v.rerender();
      confirmButton(v.tree).props.onClick();
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/teams/delete')).body, { id: 'supply' });
      v.hooks.runCleanups();
    });
  } finally {
    STATE.teams = savedTeams;
  }
});

test('a new team that takes bots from other teams says which and from where first; cancelled, nothing moves and the form stays', async () => {
  const savedTeams = STATE.teams;
  STATE.teams = [{ id: 'opc', name: { en: 'Amazon US', zh: 'Amazon US' }, tagline: { en: '', zh: '' }, color: '#10b981', template: 'opc', renamed: true, members: ['bot-b'], lead: 'bot-b' }];
  try {
    await withRoster([BOTS[0], { ...BOTS[1], team: 'opc', lead: true }, BOTS[2]], async () => {
      const v = await mountPanel();
      click(v.tree, 'data-dsh-bots-new');
      await v.rerender();
      findAll(v.tree, (n) => n.props.role === 'menuitem' && collect(n).join(' ').includes('New team'))[0].props.onClick();
      await v.rerender();
      findAll(v.tree, (n) => n.props['data-dsh-bots-field'] === 'team-name')[0].props.onChange({ target: { value: 'Supply chain' } });
      const check = (id) => findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-team-member'] === id)[0], (n) => n.props.type === 'checkbox')[0].props.onChange();
      check('bot-b');
      check('bot-c');
      await v.rerender();
      // Picked from another team: the row says it moves, and that its team loses its lead.
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-team-member-moves']).map((n) => n.props['data-dsh-bots-team-member-moves']), ['bot-b']);
      assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-team-member-moves'])[0]).join(''), /without a lead/);
      click(v.tree, 'data-dsh-bots-team-save', 'new');
      await v.rerender();
      // Nothing is created yet: the bots that move, and where from, are listed.
      assert.equal(v.posts.filter((p) => p.path.endsWith('/teams/create')).length, 0);
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-team-move']).map((n) => [n.props['data-dsh-bots-team-move'], n.props['data-lead']]), [['bot-b', true]]);
      const said = collect(findAll(v.tree, (n) => n.props['data-dsh-bots-team-moves'])[0]).join(' ');
      assert.match(said, /Creating “Supply chain” moves them to it/);
      assert.match(said, /leads Amazon US now/);
      // Cancelled: back to the form as it was.
      findAll(v.tree, (n) => n.type === 'button' && collect(n).join('') === 'Cancel')[0].props.onClick();
      await v.rerender();
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-moves']).length, 0);
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-field'] === 'team-name')[0].props.value, 'Supply chain');
      assert.equal(v.posts.filter((p) => p.path.endsWith('/teams/create')).length, 0);
      // Confirmed: created with both.
      click(v.tree, 'data-dsh-bots-team-save', 'new');
      await v.rerender();
      confirmButton(v.tree).props.onClick();
      await v.rerender(6);
      const created = v.posts.find((p) => p.path.endsWith('/teams/create'));
      assert.ok(created, 'created once confirmed');
      assert.deepEqual(created.body, { name: 'Supply chain', tagline: '', color: created.body.color, members: ['bot-b', 'bot-c'] });
      v.hooks.runCleanups();
    });
  } finally {
    STATE.teams = savedTeams;
  }
});

test('0.16.1: the rail\'s views are one-line tiles, two to a line, with their words as tooltips', async () => {
  await withTaskState({ state: { attention: ATTENTION, needs: { waiting: 0, working: 2 } }, ...TASK_COUNTS }, async () => {
    const v = await mountPanel();
    const nav = findAll(v.tree, (n) => n.props['data-dsh-bots-nav'])[0];
    assert.equal(nav.props.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
    const tiles = findAll(nav, (n) => n.type === 'button');
    assert.deepEqual(tiles.map((n) => collect(n).join(' ').split(' ')[0]), ['Requests', 'Tasks', 'Activity', 'Usage', 'Memory', 'Hire']);
    // Under way, not waiting for you: a plain count, no red badge.
    const requests = tiles[0];
    assert.equal(findAll(requests, (n) => n.props['data-dsh-bots-needs-badge'] !== undefined).length, 0);
    assert.equal(findAll(requests, (n) => n.props['data-dsh-bots-nav-count'])[0].props['data-dsh-bots-nav-count'], 2);
    assert.equal(requests.props.title, 'Requests · 2 in progress');
    v.hooks.runCleanups();
  });
});

test('0.16: a new bot joins a hired team; on its Profile it moves, and the lead switch follows the team chosen', async () => {
  await withRoster([BOTS[0], { ...BOTS[1], team: 'opc', lead: true }, BOTS[2]], async () => {
    const w = await mountPanel();
    findAll(w.tree, (n) => n.props['data-dsh-bots-new'])[0].props.onClick();
    await w.rerender(1);
    findAll(w.tree, (n) => n.props.role === 'menuitem')[0].props.onClick();
    await w.rerender(2);
    const pick = findAll(w.tree, (n) => n.props['data-dsh-bots-new-team'])[0];
    assert.deepEqual(findAll(pick, (n) => n.type === 'option').map((o) => [o.props.value, collect(o).join('')]), [['', 'No team'], ['opc', 'One-person company']]);
    findAll(w.tree, (n) => n.props['data-dsh-bots-field'] === 'new-name')[0].props.onChange({ target: { value: 'Pulse' } });
    await w.rerender(1);
    findAll(w.tree, (n) => n.props['data-dsh-bots-new-team'])[0].props.onChange({ target: { value: 'opc' } });
    await w.rerender(1);
    findAll(w.tree, (n) => n.props['data-dsh-bots-create'])[0].props.onClick();
    await flush();
    assert.equal(w.posts.find((p) => p.path.endsWith('/save')).body.bot.team, 'opc');
    w.hooks.runCleanups();

    // A bot of no team joins one on its Profile; Bob, its lead, moves out and no longer leads.
    let v = await openTab('profile', 'bot-c');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-lead']).length, 0);
    findAll(v.tree, (n) => n.props['data-dsh-bots-team-select'])[0].props.onChange({ target: { value: 'opc' } });
    await v.rerender(1);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-lead'] === 'opc').length, 1);
    assert.match(collect(v.tree).join(' '), /Bob leads One-person company now/);
    findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
    await flush();
    assert.deepEqual([v.posts.find((p) => p.path.endsWith('/save')).body.bot.team, v.posts.find((p) => p.path.endsWith('/save')).body.bot.lead], ['opc', false]);
    v.hooks.runCleanups();
    v = await openTab('profile', 'bot-b');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-select'])[0].props.value, 'opc');
    findAll(v.tree, (n) => n.props['data-dsh-bots-team-select'])[0].props.onChange({ target: { value: '' } });
    await v.rerender(1);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-lead']).length, 0);
    findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
    await flush();
    const body = v.posts.find((p) => p.path.endsWith('/save')).body.bot;
    assert.deepEqual([body.team, 'lead' in body], ['', false]);
    v.hooks.runCleanups();
    // The dispatcher has no team to pick.
    v = await openTab('profile', 'bot-a');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-team-select']).length, 0);
    v.hooks.runCleanups();
  });
});

test('skills: the Harness picker adds dsh skills by name; the GitHub picker imports items', async () => {
  let v = await openTab('skills', 'bot-a');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-harness'])[0].props.onClick();
  await v.rerender(3);
  const weekly = findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === 'weekly')[0];
  assert.equal(findAll(weekly, (n) => n.type === 'input')[0].props.disabled, true); // already added
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === 'deep-research')[0], (n) => n.type === 'input')[0].props.onChange();
  await v.rerender(1);
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === 'xlsx')[0], (n) => n.type === 'input')[0].props.onChange();
  await v.rerender(1);
  const add = findAll(v.tree, (n) => n.props['data-dsh-bots-harness-add'])[0];
  assert.match(collect(add).join(' '), /Add 2/);
  add.props.onClick();
  await flush();
  const saved = v.posts.find((p) => p.path.endsWith('/save')).body.bot;
  assert.equal(saved.id, 'bot-a');
  assert.deepEqual(saved.skills.slice(1), [
    { name: 'deep-research', source: 'dsh', enabled: true, description: 'Research a topic.' },
    { name: 'xlsx', source: 'dsh', enabled: true, description: 'Spreadsheets.' },
  ]);
  assert.equal(saved.skills[0].name, 'weekly');
  v.hooks.runCleanups();

  v = await openTab('skills', 'bot-b');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-github'])[0].props.onClick();
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-skill-source-card'] === 'anthropics')[0].props.onClick();
  await v.rerender(3);
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/github')).body, { repo: 'anthropics/skills/skills' });
  assert.match(collect(v.tree).join(' '), /mcp-builder/);
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-github-skill'] === 'skills/mcp-builder')[0], (n) => n.type === 'input')[0].props.onChange();
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-github-import'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/import')).body, { botId: 'bot-b', items: [{ repo: 'anthropics/skills', ref: 'main', path: 'skills/mcp-builder' }] });
  v.hooks.runCleanups();
});

test('skills: past the limit on, the switch refuses and new ones come in off; past the limit kept, adding is refused', async () => {
  const keep = { limits: STATE.limits, skills: BOTS[0].skills };
  STATE.limits = { skills: 3, skillsOn: 1 };
  BOTS[0].skills = [...keep.skills, { id: 's2', name: 'idle', description: 'Off for now', content: '# x', enabled: false }];
  try {
    const v = await openTab('skills', 'bot-a');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-skills-on'] === 1).length, 1);
    assert.match(collect(v.tree).join(' '), /1\/1 on/);
    // One is on already: switching the other on is refused, nothing is saved.
    findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 's2')[0], (n) => n.props.role === 'switch')[0].props.onClick();
    await v.rerender(1);
    assert.equal(v.posts.filter((p) => p.path.endsWith('/save')).length, 0);
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-toast'] === 'error')[0]).join(' '), /At most 1 skills can be on/);

    // Two from Harness would make four, past three kept: refused.
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-harness'])[0].props.onClick();
    await v.rerender(3);
    const tick = (name) => findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-harness-skill'] === name)[0], (n) => n.type === 'input')[0].props.onChange();
    tick('deep-research');
    await v.rerender(1);
    tick('xlsx');
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-harness-add'])[0].props.onClick();
    await flush();
    assert.equal(v.posts.filter((p) => p.path.endsWith('/save')).length, 0);
    // One fits, and comes in off.
    tick('xlsx');
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-harness-add'])[0].props.onClick();
    await flush();
    const saved = v.posts.find((p) => p.path.endsWith('/save')).body.bot;
    assert.deepEqual(saved.skills.at(-1), { name: 'deep-research', source: 'dsh', enabled: false, description: 'Research a topic.' });
    v.hooks.runCleanups();
  } finally {
    STATE.limits = keep.limits;
    BOTS[0].skills = keep.skills;
  }
});

test('skills: the Harness list scrolls by itself and its rows never shrink', async () => {
  const v = await openTab('skills', 'bot-a');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-harness'])[0].props.onClick();
  await v.rerender(3);
  const list = findAll(v.tree, (n) => n.props['data-dsh-bots-harness-list'])[0];
  assert.match(list.props.className, /dshb-scroll/);
  assert.notEqual(list.props.style.overflow, 'hidden');
  assert.match(source, /function PickRow[\s\S]{0,400}flex: 'none'/);
  v.hooks.runCleanups();
});

test('skills: the local picker scans a folder, marks conflicts and links by path', async () => {
  const saved = STATE.bots;
  STATE.bots = BOTS.map((b) => (b.id === 'bot-b' ? { ...b, skills: [
    { id: 'k1', name: 'notes', source: 'import', description: '', content: '', enabled: true, origin: '/home/me/skills/notes' },
    { id: 'k2', name: 'Report', source: 'own', description: '', content: '# r', enabled: true },
  ] } : b));
  try {
    const v = await openTab('skills', 'bot-b');
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-local'])[0].props.onClick();
    await v.rerender(3);
    // A known place scans in one click.
    findAll(v.tree, (n) => n.props['data-dsh-bots-local-place'] === '/home/me/.claude/skills')[0].props.onClick();
    await v.rerender(3);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/local')).body, { path: '/home/me/.claude/skills' });
    const row = (path) => findAll(v.tree, (n) => n.props['data-dsh-bots-local-skill'] === path)[0];
    const box = (path) => findAll(row(path), (n) => n.type === 'input')[0];
    assert.equal(row('/home/me/skills/fresh').props['data-state'], 'new');
    assert.equal(row('/home/me/skills/notes').props['data-state'], 'linked'); // already linked: read live, nothing to add again
    assert.equal(row('/home/me/skills/report').props['data-state'], 'taken'); // same name (any case), another source
    assert.equal(box('/home/me/skills/report').props.disabled, true);
    assert.equal(box('/home/me/skills/notes').props.disabled, true);
    // A linked skill shows its folder and has no editor: it is edited where it lives.
    const card = findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 'k1')[0];
    assert.equal(findAll(card, (n) => n.props['data-dsh-bots-skill-origin'] === '/home/me/skills/notes').length, 1);
    assert.equal(findAll(card, (n) => n.props.title === 'Edit').length, 0);
    box('/home/me/skills/fresh').props.onChange();
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-local-import'])[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/import')).body, { botId: 'bot-b', items: [{ local: '/home/me/skills/fresh' }] });
    v.hooks.runCleanups();
  } finally {
    STATE.bots = saved;
  }
});

const MAGPIE_LIB = '/home/me/.config/magpie/library/skills';
const MAGPIE = {
  ok: true,
  root: MAGPIE_LIB,
  truncated: false,
  skills: [
    { name: 'review', description: 'Review a diff.', path: `${MAGPIE_LIB}/review`, files: 1, agents: ['claude', 'codex'] },
    { name: 'tts', description: 'Text to speech.', path: `${MAGPIE_LIB}/tts`, files: 2, agents: [] },
  ],
};

test('skills: Magpie\'s library is offered when there is one, lists who Magpie gives each skill to, and links by path', async () => {
  const saved = STATE.bots;
  STATE.bots = BOTS.map((b) => (b.id === 'bot-b' ? { ...b, skills: [{ id: 'k9', name: 'review', source: 'import', from: 'magpie', description: 'Review a diff.', content: '', enabled: true, origin: `${MAGPIE_LIB}/review` }] } : b));
  try {
    // No library on this machine: no button.
    let v = await openTab('skills', 'bot-b');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-add-magpie']).length, 0);
    v.hooks.runCleanups();
    CATALOG.magpie = { root: MAGPIE_LIB };
    v = await openTab('skills', 'bot-b');
    // A skill linked from Magpie says so, and is managed there.
    const card = findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 'k9')[0];
    assert.match(collect(findAll(card, (n) => n.props['data-dsh-bots-skill-source'] === 'magpie')[0]).join(''), /Magpie/);
    assert.match(collect(findAll(card, (n) => n.props['data-dsh-bots-skill-origin'])[0]).join(''), /^Managed in Magpie$/);
    assert.equal(findAll(card, (n) => n.props.title === 'Edit').length, 0);
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-magpie'])[0].props.onClick();
    await v.rerender(3);
    // Listed at once, no folder to type; what Magpie gives each to; the one the bot has is linked already.
    assert.match(collect(v.tree).join(' '), /Add skills from Magpie/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-local-path']).length, 0);
    const row = (path) => findAll(v.tree, (n) => n.props['data-dsh-bots-local-skill'] === path)[0];
    assert.equal(row(`${MAGPIE_LIB}/review`).props['data-state'], 'linked');
    assert.match(collect(row(`${MAGPIE_LIB}/review`)).join(' '), /Magpie gives it to: claude, codex/);
    assert.match(collect(row(`${MAGPIE_LIB}/tts`)).join(' '), /Magpie gives it to no agent yet/);
    findAll(row(`${MAGPIE_LIB}/tts`), (n) => n.type === 'input')[0].props.onChange();
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-local-import'])[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/import')).body, { botId: 'bot-b', items: [{ local: `${MAGPIE_LIB}/tts` }] });
    v.hooks.runCleanups();
  } finally {
    STATE.bots = saved;
    delete CATALOG.magpie;
  }
});

test('skills: a hand-written skill cannot take a name the bot already has', async () => {
  const v = await openTab('skills', 'bot-a');
  findAll(v.tree, (n) => n.props['data-dsh-bots-add-skill'])[0].props.onClick();
  await v.rerender(1);
  const editor = () => findAll(v.tree, (n) => n.props['data-dsh-bots-skill-editor'])[0];
  findAll(editor(), (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Weekly' } });
  await v.rerender(1);
  const before = v.posts.length;
  findAll(editor(), (n) => typeof n.props.onClick === 'function' && collect(n).join(' ').includes('Save'))[0].props.onClick();
  await flush();
  assert.equal(v.posts.filter((p) => p.path.endsWith('/save')).length, 0);
  assert.equal(v.posts.length, before);
  v.hooks.runCleanups();
});

test('skills: sources are badged, Harness skills are not editable, and "let the bot write it" switches to chat', async () => {
  const saved = BOTS[1].skills;
  BOTS[1].skills = [
    { id: 'k1', name: 'deep-research', source: 'dsh', description: 'Research', content: '', enabled: true },
    { id: 'k2', name: 'pdf', source: 'import', description: 'PDFs', content: '# pdf', enabled: true, origin: 'https://github.com/anthropics/skills/tree/main/skills/pdf' },
    { id: 'k3', name: 'mine', source: 'own', description: 'Mine', content: '# mine', enabled: true },
  ];
  try {
    const v = await openTab('skills', 'bot-b');
    const text = collect(v.tree).join(' ');
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-skill-source']).map((n) => n.props['data-dsh-bots-skill-source']), ['dsh', 'import', 'own']);
    assert.match(text, /Provided by the Harness, kept up to date/);
    assert.ok(findAll(v.tree, (n) => n.type === 'a' && n.props.href === 'https://github.com/anthropics/skills/tree/main/skills/pdf').length === 1);
    const dshCard = findAll(v.tree, (n) => n.props['data-dsh-bots-skill'] === 'k1')[0];
    assert.equal(findAll(dshCard, (n) => n.props.title === 'Edit').length, 0);
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-write'])[0].props.onClick();
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-write-text'])[0].props.onChange({ target: { value: 'Weekly Stripe revenue table' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-write-send'])[0].props.onClick();
    await v.rerender(2);
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/skills/write')).body, { botId: 'bot-b', text: 'Weekly Stripe revenue table' });
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-tab'] === 'chat' && n.props['data-active'] === true).length === 1);
    v.hooks.runCleanups();
  } finally {
    BOTS[1].skills = saved;
  }
});

test('profile abilities: only available ones show, and toggling rewrites the deny list', async () => {
  const v = await openTab('profile', 'bot-a'); // Ada denies bash
  const rows = findAll(v.tree, (n) => n.props['data-dsh-bots-ability']).map((n) => [n.props['data-dsh-bots-ability'], n.props['data-on']]);
  assert.deepEqual(rows, [['web', true], ['code', false], ['plugins', true]]); // images has no tools here
  assert.match(collect(v.tree).join(' '), /Use with care/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-ability-switch'] === 'web')[0].props.onClick({});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-ability-switch'] === 'code')[0].props.onClick({});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.tools.deny, ['web_fetch', 'web_search']);
  v.hooks.runCleanups();
});

test('apps: MCP servers from other agents import by from/name; taken ones are disabled', async () => {
  const v = await openTab('apps', 'bot-b');
  assert.match(collect(v.tree).join(' '), /Found 3 MCP servers \(Codex, Claude Code\)/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-external-open'])[0].props.onClick();
  await v.rerender(1);
  assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-external-group']).map((n) => n.props['data-dsh-bots-external-group']), ['Codex', 'Claude Code']);
  const taken = findAll(v.tree, (n) => n.props['data-dsh-bots-external-item'] === 'Codex/files')[0];
  assert.equal(findAll(taken, (n) => n.type === 'input')[0].props.disabled, true);
  assert.match(collect(v.tree).join(' '), /LOGSEQ_API_TOKEN=lsq…/);
  for (const key of ['Codex/mcp-logseq', 'Claude Code/gh']) {
    findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-external-item'] === key)[0], (n) => n.type === 'input')[0].props.onChange();
    await v.rerender(1);
  }
  findAll(v.tree, (n) => n.props['data-dsh-bots-external-import'])[0].props.onClick();
  await flush();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/apps/import')).body, { botId: 'bot-b', names: ['Codex/mcp-logseq', 'Claude Code/gh'] });
  v.hooks.runCleanups();
});

test('chat: an empty thread shows the bio and suggestions that fill the composer', async () => {
  const saved = MESSAGES.splice(0);
  try {
    const v = await openTab('chat', 'bot-b');
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-chat-empty']).length === 1);
    assert.match(collect(v.tree).join(' '), /Codes/);
    findAll(v.tree, (n) => n.props['data-dsh-bots-suggestion'] === 'b1')[0].props.onClick();
    await v.rerender(1);
    assert.match(findAll(v.tree, (n) => n.props['data-dsh-bots-composer'])[0].props.value, /^Introduce yourself/);
    v.hooks.runCleanups();
  } finally {
    MESSAGES.push(...saved);
  }
});

const TABLE_REPLY = [
  '现在一共 **2** 个 bot：',
  '',
  '| Bot | 角色 |',
  '|---|---|',
  '| **@atlas** Atlas | 拆周计划 |',
  '| `@forge` Forge | [GitHub](https://github.com) |',
  '',
  '- one',
  '- two',
  '',
  'Watch https://youtu.be/dQw4w9WgXcQ and https://x.com/jack/status/20.',
].join('\n');

async function chatWith(text, opts = {}) {
  const { exports, hooks } = await loadClient(opts);
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const base = globalThis.fetch;
  const unfurled = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.startsWith('/__dsh_bots/messages')) return { ok: true, json: async () => ({ items: [{ id: 'r1', from: 'bot-a', to: 'user', text, at: Date.now(), kind: 'reply' }] }) };
    if (path.startsWith('/__dsh_bots/unfurl')) {
      const u = new URL(path, 'http://x').searchParams.get('url');
      unfurled.push(u);
      if (u.includes('youtu')) return { ok: true, json: async () => ({ ok: true, kind: 'youtube', url: u, videoId: 'dQw4w9WgXcQ', title: 'Never Gonna', author: 'Rick', image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }) };
      if (u.includes('x.com')) return { ok: true, json: async () => ({ ok: true, kind: 'x', url: u, text: 'just setting up my twttr', author: { name: 'jack', handle: 'jack', avatar: '' }, media: [], likes: 3 }) };
      return { ok: true, json: async () => ({ ok: true, kind: 'page', url: u, title: 'GitHub', description: 'Code', site: 'GitHub', image: '' }) };
    }
    return base(url, init);
  };
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  for (let i = 0; i < 3; i += 1) {
    await flush();
    hooks.rewind();
    tree = panel({});
  }
  return { tree, unfurled, posts, hooks };
}

test('bot replies render Markdown: tables, bold, code, lists and links (built-in renderer)', async () => {
  const { tree } = await chatWith(TABLE_REPLY);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-md'] === 'builtin').length, 1);
  const [table] = findAll(tree, (n) => n.type === 'table');
  assert.ok(table, 'a table');
  assert.deepEqual(findAll(table, (n) => n.type === 'th').map((n) => collect(n).join('')), ['Bot', '角色']);
  assert.equal(findAll(table, (n) => n.type === 'tr').length, 3);
  assert.ok(findAll(table, (n) => n.type === 'strong' && collect(n).join('') === '@atlas').length === 1);
  assert.ok(findAll(table, (n) => n.type === 'code' && collect(n).join('') === '@forge').length === 1);
  assert.ok(findAll(table, (n) => n.type === 'a' && n.props.href === 'https://github.com').length === 1);
  assert.equal(findAll(tree, (n) => n.type === 'ul')[0]?.children.length, 2);
  const text = collect(tree).join('');
  assert.doesNotMatch(text, /\|---|\*\*@atlas\*\*/);
});

test('with the shell renderer available, bot replies use its MarkdownText', async () => {
  const seenProps = [];
  const MarkdownText = (props) => (seenProps.push(props), { type: 'md', props, children: [props.text] });
  const { tree } = await chatWith(TABLE_REPLY, { primitives: { MarkdownText } });
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-md'] === 'harness').length, 1);
  assert.equal(seenProps.at(-1).text, TABLE_REPLY);
  assert.equal(seenProps.at(-1).labels.code.copyLabel, 'Copy');
  // A reply to you reads as the main conversation does (its body text, not the muted compact one).
  assert.equal(seenProps.at(-1).variant, 'body');
  // One labels object across renders, so the renderer keeps its parse.
  assert.equal(new Set(seenProps.map((p) => p.labels)).size, 1);
});

test('amounts in a reply are not read as math by the shell renderer', async () => {
  const seenProps = [];
  const MarkdownText = (props) => (seenProps.push(props), { type: 'md', props, children: [props.text] });
  await chatWith('Ledger created the $9 monthly / $90 annual prices. Code stays: `$9`, and so does $x^2$.', { primitives: { MarkdownText } });
  assert.equal(seenProps.at(-1).text, 'Ledger created the \\$9 monthly / \\$90 annual prices. Code stays: `$9`, and so does $x^2$.');
});

test('links in a message get rich cards: a playable YouTube video and an X post', async () => {
  const { tree, unfurled } = await chatWith(TABLE_REPLY);
  assert.deepEqual(unfurled.sort(), ['https://github.com/', 'https://x.com/jack/status/20', 'https://youtu.be/dQw4w9WgXcQ'].sort());
  const [yt] = findAll(tree, (n) => n.props['data-dsh-bots-card'] === 'youtube');
  assert.ok(yt);
  assert.match(collect(yt).join(' '), /Never Gonna/);
  assert.ok(findAll(yt, (n) => n.type === 'img' && /hqdefault/.test(n.props.src)).length === 1);
  assert.equal(findAll(yt, (n) => n.type === 'iframe').length, 0);
  const [x] = findAll(tree, (n) => n.props['data-dsh-bots-card'] === 'x');
  assert.match(collect(x).join(' '), /just setting up my twttr/);
  assert.match(collect(x).join(' '), /@jack/);
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-card'] === 'page').length === 1);
});

test('the user bubble links its URLs and a pasted link previews above the composer', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const [composer] = findAll(tree, (n) => n.props['data-dsh-bots-composer']);
  composer.props.onChange({ target: { value: 'look https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  hooks.rewind();
  panel({});
  await new Promise((r) => setTimeout(r, 450));
  hooks.rewind();
  tree = panel({});
  await flush();
  hooks.rewind();
  tree = panel({});
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-composer-preview']).length, 1);
});

// --- chat channels ---------------------------------------------------------------------------

const TG_ENTRY = {
  id: 'telegram', kind: 'channel', channel: 'telegram', name: { en: 'Telegram', zh: 'Telegram' }, description: { en: 'Message your bot team from Telegram.', zh: '在 Telegram 里给 Bot 团队发消息。' },
  category: 'computer', icon: 'TG', color: '#229ED9', serverName: 'telegram', homepage: 'https://core.telegram.org/bots', keyUrl: 'https://t.me/BotFather', featured: true,
  fields: [{ key: 'token', kind: 'secret', required: true, label: { en: 'Bot token', zh: 'Bot Token' }, help: { en: 'Message @BotFather, send /newbot.', zh: '找 @BotFather，发送 /newbot。' } }],
};
const DC_ENTRY = { ...TG_ENTRY, id: 'discord', channel: 'discord', name: { en: 'Discord', zh: 'Discord' }, icon: 'DC', color: '#5865F2', serverName: 'discord', keyUrl: 'https://discord.com/developers/applications', featured: false };

/** Run `fn` with the shared fixtures changed, then put them back. */
async function withFixtures(change, fn) {
  const saved = { templates: CATALOG.templates.slice(), apps: BOTS.map((b) => b.apps), channels: BOTS.map((b) => b.channels), messages: MESSAGES.slice() };
  change();
  try {
    await fn();
  } finally {
    CATALOG.templates.splice(0, CATALOG.templates.length, ...saved.templates);
    BOTS.forEach((b, i) => {
      b.apps = saved.apps[i];
      if (saved.channels[i] === undefined) delete b.channels;
      else b.channels = saved.channels[i];
    });
    MESSAGES.splice(0, MESSAGES.length, ...saved.messages);
  }
}

const IMAGES_ENTRY = {
  id: 'dsh-images', package: '@kadaliao/dsh-images', ability: 'images', tool: 'generate_image', name: { en: 'Images', zh: '图片 AI 作图' }, description: { en: 'Draw pictures and posters.', zh: '画图、海报。' },
  category: 'search', icon: 'IM', color: '#db2777', runtime: 'plugin', homepage: 'https://github.com/kadaliao/dsh-images', featured: true,
  installed: false, enabled: false, ready: false, version: '', canInstall: true,
};

test('apps: Images is featured beside Open Computer Use, installs in one click, and Add turns drawing on for a bot', async () => {
  const savedTools = BOTS[1].tools;
  const fetchWas = globalThis.fetch;
  try {
    // Not in this Harness yet: the card offers the install, and no Add.
    CATALOG.images = { ...IMAGES_ENTRY };
    let v = await openTab('apps', 'bot-b');
    let [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-images']);
    assert.equal(card.props['data-dsh-bots-images'], 'missing');
    // It stands right after the Open Computer Use card, above the other featured apps.
    const [ocu] = findAll(v.tree, (n) => n.props['data-dsh-bots-ocu']);
    const order = findAll(v.tree, (n) => n === ocu || n === card || n.props['data-dsh-bots-gallery-grid']);
    assert.deepEqual(order.slice(0, 2), [ocu, card]);
    let text = collect(card).join(' ');
    assert.match(text, /Images/);
    assert.match(text, /Featured/);
    assert.match(text, /Not installed/);
    assert.match(text, /Harness plugin/);
    assert.match(text, /Harness plugin @kadaliao\/dsh-images: one install serves every bot/);
    assert.match(text, /@kadaliao\/dsh-images/);
    assert.equal(findAll(card, (n) => n.props['data-dsh-bots-add-app'] === 'dsh-images').length, 0);
    // One click asks the Host, which installs it through Harness's plugin manager.
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/images/install')) {
        v.posts.push({ path: String(url), body: JSON.parse(init.body) });
        CATALOG.images = { ...IMAGES_ENTRY, installed: true, enabled: true, ready: true, version: '0.6.1' };
        return { ok: true, json: async () => ({ ok: true, application: 'applied', version: '0.6.1' }) };
      }
      return inner(url, init);
    };
    findAll(card, (n) => n.props['data-dsh-bots-images-install'])[0].props.onClick();
    await flush();
    await v.rerender();
    assert.equal(v.posts.filter((p) => p.path.endsWith('/images/install')).length, 1);
    [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-images']);
    assert.equal(card.props['data-dsh-bots-images'], 'ready');
    text = collect(card).join(' ');
    assert.match(text, /Installed/);
    assert.match(text, /Every bot can draw now/);
    // On for a bot that does not deny its tool: nothing to add.
    let [add] = findAll(card, (n) => n.props['data-dsh-bots-add-app'] === 'dsh-images');
    assert.equal(add.props.disabled, true);
    assert.match(collect(add).join(' '), /Added/);
    // Searching finds it like any app, by its name or its package.
    for (const [q, found] of [['dsh-images', true], ['图片', true], ['tavily', false]]) {
      findAll(v.tree, (n) => n.props['data-dsh-bots-app-search'])[0].props.onChange({ target: { value: q } });
      await v.rerender(1);
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-images']).length, found ? 1 : 0, q);
    }
    v.hooks.runCleanups();

    // A bot with drawing turned off: Add takes the tool off its deny list.
    BOTS[1].tools = { deny: ['bash', 'generate_image'] };
    v = await openTab('apps', 'bot-b');
    [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-images']);
    assert.match(collect(card).join(' '), /drawing is off for this bot/);
    [add] = findAll(card, (n) => n.props['data-dsh-bots-add-app'] === 'dsh-images');
    assert.equal(add.props.disabled, false);
    add.props.onClick();
    await flush();
    const saved = v.posts.find((p) => p.path.endsWith('/save')).body.bot;
    assert.equal(saved.id, 'bot-b');
    assert.deepEqual(saved.tools, { deny: ['bash'], routerAllow: [] });
    v.hooks.runCleanups();

    // Installed but switched off in Harness, or waiting for a restart.
    CATALOG.images = { ...IMAGES_ENTRY, installed: true, enabled: false };
    v = await openTab('apps', 'bot-b');
    [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-images']);
    assert.equal(card.props['data-dsh-bots-images'], 'off');
    assert.match(collect(card).join(' '), /Turn on/);
    v.hooks.runCleanups();
    CATALOG.images = { ...IMAGES_ENTRY, installed: true, enabled: true };
    v = await openTab('apps', 'bot-b');
    [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-images']);
    assert.equal(card.props['data-dsh-bots-images'], 'restart');
    assert.match(collect(card).join(' '), /Restart DeepSeek Harness to load it/);
    assert.equal(findAll(card, (n) => n.props['data-dsh-bots-images-install']).length, 0);
    v.hooks.runCleanups();
  } finally {
    delete CATALOG.images;
    BOTS[1].tools = savedTools;
    globalThis.fetch = fetchWas;
  }
});

test('channels: the gallery offers Telegram as a chat app; its form has the token and no server name', async () => {
  await withFixtures(() => CATALOG.templates.push(TG_ENTRY), async () => {
    const v = await openTab('apps', 'bot-b');
    const [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-template'] === 'telegram');
    assert.ok(card, 'a Telegram card');
    const cardText = collect(card).join(' ');
    assert.match(cardText, /chat app/);
    assert.match(cardText, /Create a bot/);
    assert.ok(findAll(card, (n) => n.type === 'a' && n.props.href === 'https://t.me/BotFather').length === 1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-add-app'] === 'telegram')[0].props.onClick();
    await v.rerender(1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-app-form'] === 'telegram').length === 1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-channel-how'] === 'telegram').length === 1);
    const text = collect(v.tree).join(' ');
    assert.doesNotMatch(text, /Server name/);
    assert.match(text, /It connects as soon as you save/);
    assert.match(text, /BotFather, send \/newbot/);
    const [token] = findAll(v.tree, (n) => n.props['data-dsh-bots-app-field'] === 'token');
    assert.equal(token.props.type, 'password');
    token.props.onChange({ target: { value: ' 123456:AAtoken ' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-app-save'])[0].props.onClick();
    await flush();
    const added = v.posts.find((p) => p.path.endsWith('/save')).body.bot.apps.at(-1);
    assert.equal(added.template, 'telegram');
    assert.equal(added.serverName, 'telegram');
    assert.deepEqual(added.values, { token: '123456:AAtoken' });
    v.hooks.runCleanups();
  });
});

test('channels: an installed chat app shows its connection, the pairing code and paired people', async () => {
  const view = {
    kind: 'telegram', state: 'connected', account: { username: 'acme_team_bot', name: 'Acme' },
    paired: [{ id: '42', name: 'Kada', at: Date.now() - 86_400_000, direct: true }],
    code: { code: 'ABC234', expiresAt: Date.now() + 9 * 60_000 }, link: 'https://t.me/acme_team_bot?start=ABC234',
    scheduleReplies: true, ignored: { count: 2, lastName: 'Mallory' },
  };
  await withFixtures(() => {
    CATALOG.templates.push(TG_ENTRY, DC_ENTRY);
    BOTS[0].apps = [{ id: 'tg1', template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: '••••••••' }, config: {} }];
    BOTS[0].channels = { tg1: view };
  }, async () => {
    const v = await openTab('apps', 'bot-a');
    const [panel] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'tg1');
    assert.ok(panel, 'the channel panel');
    const text = collect(panel).join(' ');
    assert.match(text, /Connected as @acme_team_bot/);
    assert.match(text, /Paired people \(1\)/);
    assert.match(text, /Kada/);
    assert.match(text, /gets scheduled reports/);
    assert.match(text, /expires in 9 min/);
    assert.match(text, /Ignored 2 messages from people who are not paired \(last: Mallory\)/);
    assert.match(text, /Only paired people reach the team/);
    assert.equal(findAll(panel, (n) => n.props['data-dsh-bots-pair-code'])[0].props['data-dsh-bots-pair-code'], 'ABC234');
    assert.equal(findAll(panel, (n) => n.props['data-dsh-bots-pair-link'])[0].props.href, 'https://t.me/acme_team_bot?start=ABC234');
    const row = findAll(v.tree, (n) => n.props['data-dsh-bots-app'] === 'tg1')[0];
    assert.match(collect(row).join(' '), /chat app/);
    assert.doesNotMatch(collect(row).join(' '), /mcp__telegram__/);

    findAll(panel, (n) => n.props['data-dsh-bots-new-code'] === 'tg1')[0].props.onClick();
    await flush();
    findAll(panel, (n) => n.props['data-dsh-bots-unpair'] === '42')[0].props.onClick();
    await flush();
    findAll(panel, (n) => n.props['data-dsh-bots-channel-schedules'] === 'tg1')[0].props.onClick({});
    await flush();
    const bodies = Object.fromEntries(v.posts.filter((p) => p.path.includes('/channels/')).map((p) => [p.path.split('/__dsh_bots/')[1], p.body]));
    assert.deepEqual(bodies['channels/code'], { botId: 'bot-a', appId: 'tg1' });
    assert.deepEqual(bodies['channels/unpair'], { botId: 'bot-a', appId: 'tg1', userId: '42' });
    assert.deepEqual(bodies['channels/options'], { botId: 'bot-a', appId: 'tg1', scheduleReplies: false });
    v.hooks.runCleanups();
  });
});

test('channels: a Discord error reads as what to do; nobody paired offers to pair once connected', async () => {
  await withFixtures(() => {
    CATALOG.templates.push(TG_ENTRY, DC_ENTRY);
    BOTS[0].apps = [
      { id: 'dc1', template: 'discord', name: 'Discord', serverName: 'discord', enabled: true, values: { token: '••••••••' }, config: {} },
      { id: 'tg1', template: 'telegram', name: 'Telegram', serverName: 'telegram', enabled: true, values: { token: '••••••••' }, config: {} },
    ];
    BOTS[0].channels = {
      dc1: { kind: 'discord', state: 'error', hint: 'intent', detail: 'Discord refused the Message Content intent (close 4014).', fatal: true, account: null, paired: [], code: null, link: null, invite: null, scheduleReplies: true, ignored: { count: 0 } },
      tg1: { kind: 'telegram', state: 'connected', account: { username: 'acme_team_bot' }, paired: [], code: null, link: null, scheduleReplies: true, ignored: { count: 0 } },
    };
  }, async () => {
    const v = await openTab('apps', 'bot-a');
    const [dc] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'dc1');
    const dcText = collect(dc).join(' ');
    assert.match(dcText, /Turn on Message Content Intent/);
    assert.match(dcText, /close 4014/);
    findAll(dc, (n) => n.props['data-dsh-bots-channel-reconnect'] === 'dc1')[0].props.onClick();
    await flush();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/channels/reconnect')).body, { botId: 'bot-a', appId: 'dc1' });
    const [tg] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'tg1');
    assert.match(collect(tg).join(' '), /Nobody yet/);
    const [pair] = findAll(tg, (n) => n.props['data-dsh-bots-new-code'] === 'tg1');
    assert.match(collect(pair).join(' '), /Pair yourself/);
    assert.equal(pair.props.disabled, false);
    v.hooks.runCleanups();
  });
});

test('channels: messages from and to a chat app are marked in the thread and the activity view', async () => {
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm4', from: 'user', to: 'bot-a', text: 'From my phone', at: Date.now() - 5_000, kind: 'user', via: 'telegram', who: 'Kada' },
      { id: 'm5', from: 'bot-a', to: 'user', text: 'On it.', at: Date.now() - 1_000, kind: 'reply', via: 'telegram' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    const marks = findAll(v.tree, (n) => n.props['data-dsh-bots-via'] === 'telegram').map((n) => collect(n).join(''));
    assert.deepEqual(marks, ['Telegram · Kada', '→ Telegram']);
    v.hooks.runCleanups();
  });
  const { exports, seen } = await (async () => {
    const loaded = await loadClient();
    const c = fakeContext();
    loaded.exports.apply(c.ctx);
    return { ...loaded, seen: c.seen };
  })();
  void exports;
  const en = seen.locale.dict.en;
  const zh = seen.locale.dict.zh;
  for (const hint of ['token', 'intent', 'conflict', 'duplicate']) assert.ok(en[`channelHint_${hint}`] && zh[`channelHint_${hint}`], hint);
});


// --- usage, memory, topics, settings, model sources ------------------------------------------

async function openView(attr) {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  findAll(tree, (n) => n.props[attr])[0].props.onClick();
  await rerender();
  return { hooks, posts, panel, get tree() { return tree; }, rerender };
}

test('usage: tiles, a stacked chart with legend and hover, tables by bot, model, kind, schedule and recent tasks', async () => {
  const v = await openView('data-dsh-bots-usage-entry');
  const text = collect(v.tree).join(' ');
  assert.match(text, /1\.3M/);
  assert.match(text, /95% of input from cache/);
  assert.match(text, /\$1\.23/);
  assert.match(text, /3\.0K tokens have no price/);
  assert.match(text, /\+25% vs the period before/);
  assert.match(text, /Tokens by bot/);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-usage-col'] !== undefined).length, 7);
  assert.match(text, /Conversations/);
  assert.match(text, /Memory summaries/);
  assert.match(text, /Morning brief/);
  assert.match(text, /From Telegram/);
  assert.match(text, /Running/);
  assert.match(text, /Set price/, 'an unpriced model offers to set a price');
  // Hovering a column shows its breakdown.
  findAll(v.tree, (n) => n.props['data-dsh-bots-usage-col'] === 6)[0].props.onMouseEnter();
  await v.rerender(1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-usage-tip']).length, 1);
  // The range switch asks the Host again.
  findAll(v.tree, (n) => n.props['data-dsh-bots-range'] === '30d')[0].props.onClick();
  await v.rerender();
  assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-range'] === '30d')[0].props['aria-selected']);
  // Prices.
  findAll(v.tree, (n) => n.props['data-dsh-bots-prices'])[0].props.onClick();
  await v.rerender();
  const prices = collect(v.tree).join(' ');
  assert.match(prices, /Model prices/);
  assert.match(prices, /LiteLLM’s public price list \(1800 models/);
  assert.match(prices, /No price/);
  v.hooks.runCleanups();
});

test('memory tab: notes with pin and delete, recent work, topics and a new-topic button', async () => {
  const v = await openTab('memory', 'bot-a');
  const text = collect(v.tree).join(' ');
  assert.match(text, /What Ada remembers/);
  assert.match(text, /Kada prefers short answers/);
  assert.match(text, /after a task/);
  assert.match(text, /Sent the morning brief with three items/);
  assert.match(text, /runs: 3/);
  assert.match(text, /after a quiet spell/);
  assert.match(text, /Plan the launch · Weekly review/);
  assert.match(text, /Memory work runs on each bot’s own model/);
  // Pinned notes sort first.
  const notes = findAll(v.tree, (n) => n.props['data-dsh-bots-note']).map((n) => n.props['data-dsh-bots-note']);
  assert.deepEqual(notes, ['n-2', 'n-1']);
  findAll(v.tree, (n) => n.props['data-dsh-bots-note-pin'] === 'n-1')[0].props.onClick();
  findAll(v.tree, (n) => n.props['data-dsh-bots-note-delete'] === 'n-2')[0].props.onClick();
  findAll(v.tree, (n) => n.props['data-dsh-bots-new-topic'] === 'memory')[0].props.onClick();
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/memory/put')).body, { scope: 'bot-a', note: { id: 'n-1', pinned: true } });
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/memory/delete')).body, { scope: 'bot-a', id: 'n-2' });
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/topic/new')).body, { id: 'bot-a' });
  v.hooks.runCleanups();
});

test('team memory: shared notes, digests, journal, and consolidating now', async () => {
  const v = await openView('data-dsh-bots-memory-entry');
  const text = collect(v.tree).join(' ');
  assert.match(text, /Team memory/);
  // 0.16: a note's last day, and the projects' memory with their own notes.
  assert.match(text, /until 2999-01-01/);
  assert.match(text, /past its day \(2001-01-01\)/);
  assert.match(text, /Project memory/);
  const pick = findAll(v.tree, (n) => n.props['data-dsh-bots-project-memory-pick'])[0];
  assert.deepEqual(findAll(pick, (n) => n.type === 'option').map((o) => collect(o).join('')), ['OPC · One-person company (1)', 'WEB · Website']);
  assert.match(text, /Pricing is in USD only/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-note-input'] && findAll(v.tree, (m) => m.props['data-dsh-bots-notes'] === 'pjopc00001').length)[0];
  const notes = findAll(v.tree, (n) => n.props['data-dsh-bots-notes'] === 'pjopc00001')[0];
  findAll(notes, (n) => n.props['data-dsh-bots-note-input'])[0].props.onChange({ target: { value: 'Launch is on 12/1.' } });
  await v.rerender(1);
  const notes2 = findAll(v.tree, (n) => n.props['data-dsh-bots-notes'] === 'pjopc00001')[0];
  findAll(notes2, (n) => n.props['data-dsh-bots-note-until'])[0].props.onChange({ target: { value: '2026-12-01' } });
  await v.rerender(1);
  findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-notes'] === 'pjopc00001')[0], (n) => n.props['data-dsh-bots-note-add'])[0].props.onClick();
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/memory/put')).body, { scope: 'pjopc00001', note: { text: 'Launch is on 12/1.', kind: 'fact', until: '2026-12-01' } });
  assert.match(text, /The company is called Acme/);
  assert.match(text, /2026-11-15/);
  assert.match(text, /Last consolidated/);
  assert.match(text, /every day at 03:00/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-dream'])[0].props.onClick();
  await v.rerender();
  assert.ok(v.posts.some((p) => p.path.endsWith('/memory/dream')));
  v.hooks.runCleanups();
});

test('settings: topics and memory controls save as one patch', async () => {
  const v = await openView('data-dsh-bots-settings');
  const text = collect(v.tree).join(' ');
  assert.match(text, /Bots settings/);
  assert.match(text, /New topic after this many quiet hours/);
  assert.match(text, /Model for memory work/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-setting'] === 'idleHours')[0].props.onChange({ target: { value: '3' } });
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-settings-save'])[0].props.onClick();
  await v.rerender();
  const post = v.posts.find((p) => p.path.endsWith('/settings'));
  assert.deepEqual(post.body.patch.topics, { idleHours: 3, maxContextK: 128 });
  assert.equal(post.body.patch.memory.dreamTime, '03:00');
  v.hooks.runCleanups();
});

test('chat: a topic divider and a new-topic button; the profile groups models and offers model sources', async () => {
  MESSAGES.push({ id: 'm4', from: 'system', to: 'bot-a', text: 'context', at: Date.now(), kind: 'topic' });
  BOTS[0].topic = { startedAt: Date.now() - 60_000, tasks: 2, context: 12_000 };
  try {
    const v = await openTab('chat', 'bot-a');
    let text = collect(v.tree).join(' ');
    assert.match(text, /New topic · the conversation grew large/);
    // The thread keeps itself at the bottom: it follows its own scrolling and holds what it observes.
    const [box] = findAll(v.tree, (n) => n.props['data-dsh-bots-thread'] === 'bot-a');
    assert.equal(typeof box.props.onScroll, 'function');
    assert.ok(box.props.ref && box.children[0].props.ref, 'the box and its content are both referenced');
    assert.match(text, /This topic: 12K context · runs: 2/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-new-topic'] === 'chat')[0].props.disabled, true, 'not while the bot is running');
    const p = await openTab('profile', 'bot-b');
    text = collect(p.tree).join(' ');
    assert.match(text, /Model sources/);
    findAll(p.tree, (n) => n.props['data-dsh-bots-model-sources'])[0].props.onClick();
    await p.rerender();
    text = collect(p.tree).join(' ');
    assert.match(text, /Your endpoints/);
    assert.match(text, /Local/);
    assert.match(text, /Codex CLI · ChatGPT/);
    assert.match(text, /k@example\.com · pro/);
    assert.match(text, /Anthropic allows a Claude subscription only in Claude Code/);
    findAll(p.tree, (n) => n.props['data-dsh-bots-login-connect'] === 'codex')[0].props.onClick();
    findAll(p.tree, (n) => n.props['data-dsh-bots-add-endpoint'])[0].props.onClick();
    await p.rerender();
    assert.equal(findAll(p.tree, (n) => n.props['data-dsh-bots-endpoint-form'] === 'new').length, 1);
    assert.deepEqual(p.posts.find((x) => x.path.endsWith('/models/login/connect')).body, { id: 'codex' });
    p.hooks.runCleanups();
    v.hooks.runCleanups();
  } finally {
    MESSAGES.pop();
    delete BOTS[0].topic;
  }
});

test('the model picker groups by provider and shows the thinking levels of the chosen model', async () => {
  const saved = CATALOG.models;
  CATALOG.models = [
    { provider: 'p', model: 'm', label: 'P · M', group: 'P', name: 'M', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high', context: 1_000_000 },
    { provider: 'bots-local', model: 'qwen', label: 'Local · qwen', group: 'Local', name: 'qwen', source: 'custom' },
  ];
  CATALOG.defaultModel = { provider: 'p', model: 'm' };
  try {
    const v = await openTab('profile', 'bot-b');
    const groups = findAll(v.tree, (n) => n.type === 'optgroup').map((n) => n.props.label);
    assert.deepEqual(groups, ['P', 'Local · your endpoint']);
    const text = collect(v.tree).join(' ');
    assert.match(text, /Harness default \(m\)/);
    assert.match(text, /P · context window 1\.0M tokens/);
    const effort = findAll(v.tree, (n) => n.props['data-dsh-bots-effort'])[0];
    assert.ok(effort);
    effort.props.onChange({ target: { value: 'low' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-save'])[0].props.onClick();
    await v.rerender();
    assert.deepEqual(v.posts.find((x) => x.path.endsWith('/save')).body.bot.model, { provider: 'p', model: 'm', reasoningEffort: 'low' });
    v.hooks.runCleanups();
  } finally {
    CATALOG.models = saved;
    delete CATALOG.defaultModel;
  }
});

// --- tasks, the dispatcher's mode, the router notice ------------------------------------------

/** Run `fn` with extra fields on the shared fixtures, put back afterwards. */
async function withTaskState(patch, fn) {
  const saved = { state: { ...STATE }, bots: BOTS.map((b) => ({ tickets: b.tickets, tools: b.tools })) };
  Object.assign(STATE, patch.state ?? {});
  (patch.bots ?? []).forEach((p, i) => p && Object.assign(BOTS[i], p));
  try {
    await fn();
  } finally {
    for (const k of Object.keys(STATE)) if (!(k in saved.state)) delete STATE[k];
    Object.assign(STATE, saved.state);
    BOTS.forEach((b, i) => {
      if (saved.bots[i].tickets === undefined) delete b.tickets;
      else b.tickets = saved.bots[i].tickets;
      b.tools = saved.bots[i].tools;
    });
  }
}
const ATTENTION = TICKETS.filter((r) => ['question', 'failed', 'stalled'].includes(r.stage));
const TASK_COUNTS = { bots: [null, { tickets: { working: 1, question: 1, stalled: 0, queued: 0 } }, { tickets: { working: 0, question: 0, stalled: 1, queued: 1 } }] };
const click = (tree, attr, value = true) => {
  const [node] = findAll(tree, (n) => (value === true ? Boolean(n.props[attr]) : n.props[attr] === value));
  assert.ok(node, `${attr}=${value}`);
  node.props.onClick?.({ stopPropagation() {} });
};
const confirmButton = (tree) => findAll(tree, (n) => n.type === 'button' && n.props.className === 'dshb-btn dshb-btn-primary dshb-btn-danger')[0];

test('tasks: the rail badge counts what needs you; the view groups needs you, in progress and recently done', async () => {
  await withTaskState({ state: { attention: ATTENTION }, ...TASK_COUNTS }, async () => {
    const v = await openView('data-dsh-bots-tasks-entry');
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-badge'] !== undefined);
    assert.equal(badge.props['data-dsh-bots-tasks-badge'], 3);
    assert.equal(collect(badge).join(''), '3');
    assert.equal(badge.props['aria-label'], '3 need you');
    const groups = findAll(v.tree, (n) => n.props['data-dsh-bots-task-group']).map((n) => [n.props['data-dsh-bots-task-group'], findAll(n, (x) => x.props['data-dsh-bots-task']).map((x) => x.props['data-dsh-bots-task'])]);
    assert.deepEqual(groups, [
      ['needs', ['tquestion', 'tfailed01', 'tstalled1']],
      ['progress', ['tqueued01', 'tworking1']],
      ['done', ['tdone0001', 'tstopped1']],
    ]);
    const row = findAll(v.tree, (n) => n.props['data-dsh-bots-task'] === 'tquestion')[0];
    const text = collect(row).join(' ');
    assert.match(text, /Which logo do you prefer\?/);
    assert.match(text, /Needs your answer/);
    assert.match(text, /Bob/);
    assert.match(text, /asked by Ada/);
    assert.match(text, /Telegram/);
    assert.match(text, /2 min ago/);
    assert.match(text, /Blue or green\?/);
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-task'] === 'tstalled1')[0]).join(' '), /asked by you .*Panel/);
    // Filtering by bot asks the Host for that bot's tasks.
    const fetched = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => (fetched.push(String(url)), inner(url, init));
    findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-bot'])[0].props.onChange({ target: { value: 'bot-c' } });
    await v.rerender();
    assert.ok(fetched.includes('/__dsh_bots/tickets?limit=200&bot=bot-c'), fetched.join(', '));
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-task']).map((n) => n.props['data-dsh-bots-task']), ['tstalled1', 'tqueued01', 'tstopped1']);
    v.hooks.runCleanups();
  });
  // No tasks at all: one empty state; per-section words when only some are empty.
  const saved = TICKETS.splice(0);
  try {
    const v = await openView('data-dsh-bots-tasks-entry');
    const text = collect(v.tree).join(' ');
    assert.match(text, /No tasks yet/);
    assert.match(text, /hands work to a teammate/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-badge'] !== undefined).length, 0);
    // The rail's tile says it in its tooltip (0.16.1).
    assert.match(findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-entry'])[0].props.title, /Work handed to your bots/);
    v.hooks.runCleanups();
    TICKETS.push(saved.find((r) => r.id === 'tdone0001'));
    const w = await openView('data-dsh-bots-tasks-entry');
    const words = collect(w.tree).join(' ');
    assert.match(words, /Nothing needs you right now\./);
    assert.match(words, /Nothing is in progress\./);
    assert.match(words, /Weekly numbers/);
    w.hooks.runCleanups();
  } finally {
    TICKETS.splice(0, TICKETS.length, ...saved);
  }
});

test('tasks: the detail shows who, where from, the reports and usage; each action posts to its route', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const posts = mockFetch();
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (n = 3) => {
    for (let i = 0; i < n; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  click(tree, 'data-dsh-bots-tasks-entry');
  await rerender();
  click(tree, 'data-dsh-bots-task', 'tquestion');
  await rerender();
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
  let text = collect(tree).join(' ');
  assert.match(text, /Which logo do you prefer\?/);
  assert.match(text, /Needs your answer/);
  const fact = (name) => collect(findAll(tree, (n) => n.props['data-dsh-bots-ticket-fact'] === name)[0]).join(' ');
  assert.match(fact('bot'), /Bob/);
  assert.match(fact('requester'), /Ada/);
  assert.match(fact('from'), /Telegram · Kada/);
  assert.doesNotMatch(fact('from'), /Kada .*Kada/, 'who is not repeated when the label has it');
  assert.match(text, /Draw two logo options/);
  // Reports in time order, rendered like bot replies (Markdown).
  assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-report-item']).map((n) => n.props['data-dsh-bots-report-item']), ['progress', 'question']);
  assert.ok(findAll(tree, (n) => n.type === 'strong' && collect(n).join('') === 'Blue').length === 1);
  // Usage: the Host's totals, and the number of runs.
  const tile = (attr) => collect(findAll(tree, (n) => n.props['data-dsh-bots-tile'] === attr)[0]).join(' ');
  assert.match(tile('ticket-tokens'), /Tokens 16K/);
  assert.match(tile('ticket-cost'), /\$0\.030/);
  assert.match(tile('ticket-runs'), /Runs 2/);
  // The parent and the sub-task show as cards with their own titles.
  assert.match(collect(findAll(tree, (n) => n.props['data-dsh-bots-ticket-parent'] === 'tworking1')[0]).join(' '), /Fix the login bug/);
  assert.match(collect(findAll(tree, (n) => n.props['data-dsh-bots-ticket-children'] === 1)[0]).join(' '), /Translate the docs .*Queued/);
  // A question asks for an answer; no Retry for an open question.
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket-composer'])[0].props.placeholder, 'Answer Bob…');
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket-retry']).length, 0);

  // Open conversation: the task's own Harness session.
  click(tree, 'data-dsh-bots-ticket-open', 'tquestion');
  assert.deepEqual(seen.opened, ['ticket-tquestion']);

  // Stop and Close ask first, then post.
  click(tree, 'data-dsh-bots-ticket-stop', 'tquestion');
  await rerender(1);
  assert.match(collect(tree).join(' '), /Stop “Which logo do you prefer\?”\?/);
  assert.equal(posts.length, 0, 'nothing posted before confirming');
  confirmButton(tree).props.onClick();
  await rerender();
  assert.ok(posts.some((p) => p.path === '/__dsh_bots/tickets/tquestion/stop'));
  assert.match(collect(tree).join(' '), /Task stopped\./);
  click(tree, 'data-dsh-bots-ticket-close', 'tquestion');
  await rerender(1);
  assert.match(collect(tree).join(' '), /Mark “Which logo do you prefer\?” done\?/);
  confirmButton(tree).props.onClick();
  await rerender();
  assert.ok(posts.some((p) => p.path === '/__dsh_bots/tickets/tquestion/close'));

  // A message to the task: Enter sends it.
  const [box] = findAll(tree, (n) => n.props['data-dsh-bots-ticket-composer'] === 'tquestion');
  box.props.onChange({ target: { value: 'Blue, please' } });
  await rerender(1);
  let prevented = false;
  findAll(tree, (n) => n.props['data-dsh-bots-ticket-composer'] === 'tquestion')[0].props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => (prevented = true) });
  await rerender();
  assert.equal(prevented, true);
  assert.deepEqual(posts.find((p) => p.path === '/__dsh_bots/tickets/tquestion/message').body, { text: 'Blue, please' });
  // A file is referenced from the folder the task works in: the picker asks for the task's files.
  const gets = [];
  const plain = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('/__dsh_bots/files?')) return plain(url, init);
    gets.push(String(url));
    return { ok: true, json: async () => ({ ok: true, root: '/Users/me/opc', files: ['docs/plan.md'], truncated: false }) };
  };
  click(tree, 'data-dsh-bots-file-button', 'ticket');
  await rerender();
  assert.deepEqual(gets, ['/__dsh_bots/files?ticket=tquestion&q=']);
  click(tree, 'data-dsh-bots-file-option', 'docs/plan.md');
  await rerender(1);
  click(tree, 'data-dsh-bots-ticket-send', 'tquestion');
  await rerender();
  assert.deepEqual(posts.filter((p) => p.path === '/__dsh_bots/tickets/tquestion/message').at(-1).body, { text: '', files: ['docs/plan.md'] });
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-file-ref']).length, 0, 'sent: the composer is clear');
  globalThis.fetch = plain;

  // Back to the list, then a failed task: its error, and Retry without asking.
  click(tree, 'data-dsh-bots-tasks-back');
  await rerender();
  assert.ok(findAll(tree, (n) => n.props['data-dsh-bots-tasks']).length === 1);
  click(tree, 'data-dsh-bots-task', 'tfailed01');
  await rerender();
  text = collect(tree).join(' ');
  assert.match(text, /Connection refused \(3 tries\)\./);
  assert.equal(fact('from'), 'From The Bots panel', 'the panel in words of the page, not the Host');
  assert.doesNotMatch(text, /the user/);
  assert.match(text, /No model calls yet\./);
  assert.match(text, /No report yet\. Bob reports when it is done, stuck, or has a question\./);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-ticket-stop']).length, 0, 'a failed task that ended cannot be stopped');
  click(tree, 'data-dsh-bots-ticket-retry', 'tfailed01');
  await rerender();
  assert.ok(posts.some((p) => p.path === '/__dsh_bots/tickets/tfailed01/retry'));
  hooks.runCleanups();
});

test('tasks: a bot page lists its open tasks and links to all of them', async () => {
  await withTaskState(TASK_COUNTS, async () => {
    const v = await openTab('tasks', 'bot-b');
    const tab = findAll(v.tree, (n) => n.props['data-dsh-bots-tab'] === 'tasks')[0];
    assert.match(collect(tab).join(' '), /Tasks 2/);
    const [list] = findAll(v.tree, (n) => n.props['data-dsh-bots-bot-tasks'] === 'bot-b');
    const ids = findAll(list, (n) => n.props['data-dsh-bots-task']).map((n) => n.props['data-dsh-bots-task']);
    assert.deepEqual(ids, ['tquestion', 'tworking1', 'tfailed01', 'tdone0001']);
    assert.match(collect(list).join(' '), /What Bob is working on/);
    findAll(v.tree, (n) => n.props['data-dsh-bots-bot-tasks-all'] === 'bot-b')[0].props.onClick();
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-tasks-bot'])[0].props.value, 'bot-b');
    // A row opens its task.
    click(v.tree, 'data-dsh-bots-task', 'tworking1');
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tworking1').length, 1);
    v.hooks.runCleanups();
  });
});

test('requests: the rail counts what waits for you; the board groups the person\'s requests and keeps dropped ones folded', async () => {
  await withTaskState({ state: { needs: { waiting: 1, working: 1 } } }, async () => {
    const v = await openView('data-dsh-bots-needs-entry');
    const entry = findAll(v.tree, (n) => n.props['data-dsh-bots-needs-entry'])[0];
    // A one-line tile: its name and the red count; the words are its tooltip (0.16.1).
    assert.equal(entry.props.title, 'Requests · 1 waiting for you');
    assert.match(collect(entry).join(' '), /Requests .*1/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-needs-badge'] !== undefined)[0].props['data-dsh-bots-needs-badge'], 1);
    assert.ok(findAll(v.tree, (n) => n.props['data-dsh-bots-needs']).length === 1, 'the board is shown');
    const groups = findAll(v.tree, (n) => n.props['data-dsh-bots-need-group']).map((n) => [n.props['data-dsh-bots-need-group'], findAll(n, (x) => x.props['data-dsh-bots-need']).map((x) => x.props['data-dsh-bots-need'])]);
    assert.deepEqual(groups, [
      ['todo', ['ntodo0001']],
      ['working', ['nworking1']],
      ['needs', ['nwaiting1']],
      ['done', ['ndone0001']],
      ['stopped', []],
    ]);
    const text = collect(v.tree).join(' ');
    assert.equal(collect(findAll(v.tree, (n) => n.props["data-dsh-bots-needs-week"])[0]).join(""), "This week: 4 requests · 1 done · 1 in progress · 1 waiting for you");
    const waiting = collect(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'nwaiting1')[0]).join(' ');
    assert.match(waiting, /A logo for the launch/);
    assert.match(waiting, /Waiting for you/);
    assert.match(waiting, /Telegram · Kada/);
    assert.match(waiting, /Blue or green\?/);
    const working = collect(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'nworking1')[0]).join(' ');
    assert.match(working, /1\/3 done/);
    assert.match(working, /^OPC-1 1\/3 done Q3 competitor pricing table/, 'a card leads with its reference');
    assert.match(findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'nworking1')[0], (n) => n.props['data-dsh-bots-need-bots'] === 2)[0].props.title, /^Bob、/);
    assert.match(working, /1 of its tasks did not get done/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-stalled'] !== undefined).length, 0, 'nothing stuck here');
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'ndone0001')[0]).join(' '), /delivered 1 h ago/);
    // Dropped ones fold away until asked for.
    click(v.tree, 'data-dsh-bots-needs-stopped');
    await v.rerender(1);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'nstopped1').length, 1);
    // The tasks stay one click away.
    click(v.tree, 'data-dsh-bots-needs-tasks');
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-tasks']).length, 1);
    v.hooks.runCleanups();
  });
});

test('requests: one request shows your words, the question waiting for you, what was delivered and its tasks; rename and drop post to their routes', async () => {
  const v = await openView('data-dsh-bots-needs-entry');
  click(v.tree, 'data-dsh-bots-need', 'nwaiting1');
  await v.rerender();
  const detail = () => findAll(v.tree, (n) => n.props['data-dsh-bots-need-detail'] === 'nwaiting1')[0];
  assert.ok(detail());
  const text = collect(detail()).join(' ');
  assert.match(text, /A logo for the launch/);
  assert.match(text, /Titled with your own words/);
  assert.match(text, /What you said .*Make us a logo .*Something calm, please/);
  assert.match(text, /Bob asks:/);
  assert.match(text, /Nothing delivered yet\./);
  assert.match(text, /The tasks behind it \(1\)/);
  assert.equal(findAll(detail(), (n) => n.props['data-dsh-bots-task'] === 'tquestion').length, 1);
  // Rename: an input, then the route.
  click(v.tree, 'data-dsh-bots-need-rename', 'nwaiting1');
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-title-input'])[0].props.onChange({ target: { value: 'Launch logo, calm colours' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-need-title-save');
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/nwaiting1/rename')).body, { title: 'Launch logo, calm colours' });
  // Drop: confirmed first.
  click(v.tree, 'data-dsh-bots-need-drop', 'nwaiting1');
  await v.rerender(1);
  assert.match(collect(v.tree).join(' '), /Drop “A logo for the launch”\?/);
  confirmButton(v.tree).props.onClick();
  await v.rerender();
  assert.ok(v.posts.some((p) => p.path.endsWith('/needs/nwaiting1/drop')));
  // Answer: to the task that asks, in the Tasks view.
  click(v.tree, 'data-dsh-bots-need-answer', 'tquestion');
  await v.rerender();
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
  v.hooks.runCleanups();
  // A delivered one shows the result.
  const w = await openView('data-dsh-bots-needs-entry');
  click(w.tree, 'data-dsh-bots-need', 'ndone0001');
  await w.rerender();
  assert.match(collect(w.tree).join(' '), /What was delivered .*Bob/);
  assert.equal(findAll(w.tree, (n) => n.props['data-dsh-bots-need-results'] === 1).length, 1);
  assert.equal(findAll(w.tree, (n) => n.props['data-dsh-bots-need-drop'] !== undefined).length, 0, 'nothing to drop once delivered');
  w.hooks.runCleanups();
});

/** The board, with every GET kept: `asked()` is the query of the last list of cards the host was asked for. */
async function openBoard(answer = () => null) {
  const v = await openView('data-dsh-bots-needs-entry');
  const base = globalThis.fetch;
  const gets = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'POST') {
      gets.push(String(url));
      const mine = answer(new URL(String(url), 'http://x'));
      if (mine) return { ok: true, json: async () => mine };
    }
    return base(url, init);
  };
  const asked = () => Object.fromEntries(new URL(gets.filter((u) => u.startsWith('/__dsh_bots/needs?')).at(-1), 'http://x').searchParams);
  return { v, gets, asked };
}

test('board filters: a period is whole days of your calendar, days picked by hand count the last one whole, words wait for the input method; Clear puts the board back', async () => {
  const day = (y, m, d) => String(new Date(y, m - 1, d).getTime());
  const realNow = Date.now;
  const { v, asked } = await openBoard();
  const period = async (id) => {
    click(v.tree, 'data-dsh-bots-board-period', id);
    await v.rerender();
    return asked();
  };
  try {
    // Sunday 1 November 2026, in the afternoon: the week began on Monday 26 October, and the month today.
    Date.now = () => new Date(2026, 10, 1, 15, 30).getTime();
    assert.deepEqual(await period('today'), { limit: '300', from: day(2026, 11, 1), to: day(2026, 11, 2) });
    assert.deepEqual(await period('week'), { limit: '300', from: day(2026, 10, 26), to: day(2026, 11, 2) });
    assert.deepEqual(await period('month'), { limit: '300', from: day(2026, 11, 1), to: day(2026, 12, 1) });
    assert.deepEqual(await period('lastMonth'), { limit: '300', from: day(2026, 10, 1), to: day(2026, 11, 1) });
    // In January, last month is December of the year before.
    Date.now = () => new Date(2027, 0, 15, 9).getTime();
    await v.rerender();
    assert.deepEqual(asked(), { limit: '300', from: day(2026, 12, 1), to: day(2027, 1, 1) });
    // Narrowed: how many cards that leaves, in place of the week's summary.
    assert.equal(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-board-matches'] !== undefined)[0]).join(''), 'Matching cards: 5');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-needs-week'] !== undefined).length, 0);
    // Days picked by hand: nothing is narrowed until one is picked; the last day counts whole.
    const date = (key) => findAll(v.tree, (n) => n.props['data-dsh-bots-board-date'] === key)[0];
    assert.equal(date('from'), undefined);
    assert.deepEqual(await period('custom'), { limit: '300' });
    date('from').props.onChange({ target: { value: '2026-11-01' } });
    date('to').props.onChange({ target: { value: '2026-11-26' } });
    await v.rerender();
    assert.deepEqual(asked(), { limit: '300', from: day(2026, 11, 1), to: day(2026, 11, 27) });
    // The wrong way round is the same days; one end may stay open.
    date('from').props.onChange({ target: { value: '2026-11-26' } });
    date('to').props.onChange({ target: { value: '2026-11-01' } });
    await v.rerender();
    assert.deepEqual(asked(), { limit: '300', from: day(2026, 11, 1), to: day(2026, 11, 27) });
    date('from').props.onChange({ target: { value: '' } });
    await v.rerender();
    assert.deepEqual(asked(), { limit: '300', to: day(2026, 11, 2) });
    // Words go to the host with the days; text an input method has not finished is not searched for.
    const box = () => findAll(v.tree, (n) => n.props['data-dsh-bots-board-search'])[0];
    box().props.onChange({ target: { value: ' 报价 ' } });
    await v.rerender();
    assert.deepEqual(asked(), { limit: '300', to: day(2026, 11, 2), q: '报价' });
    box().props.onChange({ target: { value: 'baobiao' }, nativeEvent: { isComposing: true } });
    await v.rerender();
    assert.deepEqual([box().props.value, asked().q], ['baobiao', '报价']);
    box().props.onCompositionEnd({ target: { value: '报表' } });
    await v.rerender();
    assert.equal(asked().q, '报表');
    // A project chip picks among what came back; Clear drops the project, the days and the words.
    click(v.tree, 'data-dsh-bots-board-filter', 'pjopc00001');
    await v.rerender(1);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-board-matches'] !== undefined)[0].props['data-dsh-bots-board-matches'], 2);
    Date.now = realNow;
    click(v.tree, 'data-dsh-bots-board-clear');
    await v.rerender();
    assert.deepEqual(asked(), { limit: '300' });
    assert.equal(box().props.value, '');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-board-clear']).length, 0);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-board-filter'] === 'all')[0].props['data-active'], true);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-needs-week'] !== undefined).length, 1);
  } finally {
    Date.now = realNow;
    v.hooks.runCleanups();
  }
});

test('board archive: Archived lists the cards put away, page by page, searched like the board; Restore and the card\'s page post to their routes', async () => {
  const card = (id, title, over = {}) => ({ id, title, status: 'done', done: 1, total: 1, bots: ['bot-b'], createdAt: Date.now() - 40 * 24 * 60 * MIN, updatedAt: Date.now() - 30 * 24 * 60 * MIN, archivedAt: Date.now() - 20 * 24 * 60 * MIN, ...over });
  const shelf = [card('narchive01', 'Quote for Berlin'), card('narchive02', 'Old logo', { status: 'stopped' }), card('narchive03', 'Spring newsletter')];
  const { v, asked } = await openBoard((url) => {
    if (url.pathname === '/__dsh_bots/needs/narchive01') return { asks: [], results: [], tickets: [], ...shelf[0] };
    if (url.pathname !== '/__dsh_bots/needs' || url.searchParams.get('archived') !== '1') return null;
    // Two cards a page; the second page repeats one (a card changed in between).
    return url.searchParams.get('offset') ? { items: shelf.slice(1), next_offset: null } : { items: shelf.slice(0, 2), next_offset: 2 };
  });
  const listed = () => findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-board-archive'] !== undefined)[0], (n) => n.props['data-dsh-bots-need']).map((n) => n.props['data-dsh-bots-need']);
  click(v.tree, 'data-dsh-bots-board-archived', 'off');
  await v.rerender();
  assert.deepEqual(asked(), { limit: '300', archived: '1' });
  assert.deepEqual(listed(), ['narchive01', 'narchive02']);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-board']).length, 0, 'one list, no columns');
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] && n.props.draggable).length, 0);
  assert.match(collect(v.tree).join(' '), /Archived cards: 2/);
  // The next page, on request.
  click(v.tree, 'data-dsh-bots-board-more', 2);
  await v.rerender();
  assert.deepEqual(asked(), { limit: '300', archived: '1', offset: '2' });
  assert.deepEqual(listed(), ['narchive01', 'narchive02', 'narchive03']);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-board-more'] !== undefined).length, 0);
  // Words search the archive.
  findAll(v.tree, (n) => n.props['data-dsh-bots-board-search'])[0].props.onChange({ target: { value: 'quote' } });
  await v.rerender();
  assert.deepEqual(asked(), { limit: '300', q: 'quote', archived: '1' });
  // Restore, from the list: the card is not opened.
  click(v.tree, 'data-dsh-bots-need-restore', 'narchive02');
  await v.rerender();
  assert.deepEqual(v.posts.at(-1), { path: '/__dsh_bots/needs/narchive02/unarchive', body: {} });
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-detail'] !== undefined).length, 0);
  // Its page says it is archived, and restores it too; back, the archive and its search are as they were.
  click(v.tree, 'data-dsh-bots-need', 'narchive01');
  await v.rerender();
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-archived'] === 'narchive01').length, 1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-archive'] !== undefined).length, 0);
  click(v.tree, 'data-dsh-bots-need-unarchive', 'narchive01');
  await v.rerender();
  assert.deepEqual(v.posts.at(-1), { path: '/__dsh_bots/needs/narchive01/unarchive', body: {} });
  click(v.tree, 'data-dsh-bots-needs-back');
  await v.rerender();
  assert.deepEqual(asked(), { limit: '300', q: 'quote', archived: '1' });
  // Back to the board: the cards not archived, still narrowed by the words.
  click(v.tree, 'data-dsh-bots-board-archived', 'on');
  await v.rerender();
  assert.deepEqual(asked(), { limit: '300', q: 'quote' });
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-board']).length, 1);
  // A card that is done (or dropped) is archived from its page; one under way is not.
  click(v.tree, 'data-dsh-bots-need', 'ndone0001');
  await v.rerender();
  click(v.tree, 'data-dsh-bots-need-archive', 'ndone0001');
  await v.rerender();
  assert.deepEqual(v.posts.at(-1), { path: '/__dsh_bots/needs/ndone0001/archive', body: {} });
  click(v.tree, 'data-dsh-bots-needs-back');
  await v.rerender();
  click(v.tree, 'data-dsh-bots-need', 'nworking1');
  await v.rerender();
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-archive'] !== undefined || n.props['data-dsh-bots-need-unarchive'] !== undefined).length, 0);
  v.hooks.runCleanups();
});

test('the dispatcher has no mode to pick (0.11): its profile shows the light-model hint, and nothing to switch', async () => {
  const v = await openTab('profile', 'bot-a');
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-dispatcher-modes'] !== undefined || n.props['data-dsh-bots-dispatcher-mode'] !== undefined).length, 0);
  assert.doesNotMatch(collect(v.tree).join(' '), /How it works|Hands-on|Router mode/);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 1);
  assert.match(collect(v.tree).join(' '), /It only understands, hands out and reports, so a light, fast model is enough/);
  v.hooks.runCleanups();
  // Only the dispatcher has the hint.
  const b = await openTab('profile', 'bot-b');
  assert.equal(findAll(b.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 0);
  b.hooks.runCleanups();
});

test('a team: sub-agents are off for the dispatcher, shown as such and not switchable; the other bots keep the switch', async () => {
  const saved = { abilities: CATALOG.abilities, teamDeny: CATALOG.teamDeny };
  CATALOG.abilities = [
    ...saved.abilities,
    { id: 'delegate', name: { en: 'Sub-agents & workflows', zh: '子代理与工作流' }, description: { en: 'Split big jobs.', zh: '拆给子代理。' }, tools: ['subagent', 'wait_agent'], available: ['subagent', 'wait_agent'] },
  ];
  CATALOG.teamDeny = ['subagent', 'wait_agent'];
  try {
    const v = await openTab('profile', 'bot-a');
    const [row] = findAll(v.tree, (n) => n.props['data-dsh-bots-ability'] === 'delegate');
    assert.equal(row.props['data-on'], false);
    assert.equal(collect(findAll(row, (n) => n.props['data-dsh-bots-team-off'] === 'delegate')[0]).join(''), 'Off for the dispatcher');
    assert.equal(findAll(row, (n) => n.props['data-dsh-bots-router-off'] !== undefined).length, 0, 'one reason is enough');
    const [sw] = findAll(row, (n) => n.props['data-dsh-bots-ability-switch'] === 'delegate');
    assert.equal(sw.props.disabled, true);
    v.hooks.runCleanups();
    const b = await openTab('profile', 'bot-b');
    const [own] = findAll(b.tree, (n) => n.props['data-dsh-bots-ability'] === 'delegate');
    assert.equal(own.props['data-on'], true);
    assert.equal(findAll(own, (n) => n.props['data-dsh-bots-team-off'] !== undefined).length, 0);
    assert.notEqual(findAll(own, (n) => n.props['data-dsh-bots-ability-switch'] === 'delegate')[0].props.disabled, true);
    b.hooks.runCleanups();
  } finally {
    CATALOG.abilities = saved.abilities;
    if (saved.teamDeny === undefined) delete CATALOG.teamDeny;
    else CATALOG.teamDeny = saved.teamDeny;
  }
});

test('router mode: abilities a router goes without are marked, and each comes back through routerAllow', async () => {
  const saved = CATALOG.abilities;
  CATALOG.abilities = [
    ...saved,
    { id: 'files', name: { en: 'Files', zh: '读写文件' }, description: { en: 'Read and write files.', zh: '读写文件。' }, tools: ['read', 'write', 'edit'], available: ['read', 'write', 'edit'] },
  ];
  try {
    await withTaskState({ bots: [{ tools: { deny: [] } }] }, async () => {
      const v = await openTab('profile', 'bot-a');
      const rows = () => findAll(v.tree, (n) => n.props['data-dsh-bots-ability']).map((n) => [n.props['data-dsh-bots-ability'], n.props['data-on']]);
      assert.deepEqual(rows(), [['web', true], ['code', false], ['plugins', true], ['files', true]]);
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off']).map((n) => [n.props['data-dsh-bots-router-off'], collect(n).join('')]), [['code', 'Off for dispatching'], ['files', 'Partly off for dispatching']]);
      assert.match(collect(v.tree).join(' '), /As the dispatcher it does not search the web, run commands/);
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-tool'] === 'bash').length, 1, 'the per-tool list marks it too');
      // Commands back on: through routerAllow; writing files back on: its own link.
      click(v.tree, 'data-dsh-bots-ability-switch', 'code');
      await v.rerender(1);
      click(v.tree, 'data-dsh-bots-router-allow', 'files');
      await v.rerender(1);
      assert.deepEqual(rows(), [['web', true], ['code', true], ['plugins', true], ['files', true]]);
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-allowed']).map((n) => n.props['data-dsh-bots-router-allowed']), ['code', 'files']);
      click(v.tree, 'data-dsh-bots-save');
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.tools, { deny: [], routerAllow: ['bash', 'edit', 'write'] });
      v.hooks.runCleanups();
    });
    // Allowed back already: switching it off again only drops it from routerAllow (working alone keeps it).
    await withTaskState({ bots: [{ tools: { deny: [], routerAllow: ['bash'] } }] }, async () => {
      const v = await openTab('profile', 'bot-a');
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ability'] === 'code')[0].props['data-on'], true);
      click(v.tree, 'data-dsh-bots-ability-switch', 'code');
      await v.rerender(1);
      click(v.tree, 'data-dsh-bots-save');
      await v.rerender();
      assert.deepEqual(v.posts.find((p) => p.path.endsWith('/save')).body.bot.tools, { deny: [], routerAllow: [] });
      v.hooks.runCleanups();
    });
    // Every other bot sees the abilities as before.
    const b = await openTab('profile', 'bot-b');
    assert.equal(findAll(b.tree, (n) => n.props['data-dsh-bots-router-off'] || n.props['data-dsh-bots-router-allowed']).length, 0);
    assert.deepEqual(findAll(b.tree, (n) => n.props['data-dsh-bots-ability']).map((n) => n.props['data-on']), [true, true, true, true]);
    b.hooks.runCleanups();
    // The Host's own list wins when the catalog has one.
    CATALOG.routerDeny = ['bash'];
    try {
      await withTaskState({ bots: [{ tools: { deny: [] } }] }, async () => {
        const v = await openTab('profile', 'bot-a');
        assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off']).map((n) => n.props['data-dsh-bots-router-off']), ['code']);
        v.hooks.runCleanups();
      });
    } finally {
      delete CATALOG.routerDeny;
    }
  } finally {
    CATALOG.abilities = saved;
  }
});

test('settings: concurrent tasks, minutes before stuck and hours before archiving save with the rest', async () => {
  const v = await openView('data-dsh-bots-settings');
  const text = collect(v.tree).join(' ');
  assert.match(text, /Tasks worked on at once/);
  assert.match(text, /Minutes before a quiet task counts as stuck/);
  assert.match(text, /Hours before a finished task’s conversation is archived/);
  const field = (name) => findAll(v.tree, (n) => n.props['data-dsh-bots-setting'] === name)[0];
  assert.deepEqual(['maxWorking', 'stallMinutes', 'archiveHours'].map((k) => field(k).props.value), [4, 20, 24], 'the Host defaults when settings have none');
  field('maxWorking').props.onChange({ target: { value: '6' } });
  field('stallMinutes').props.onChange({ target: { value: '' } });
  field('archiveHours').props.onChange({ target: { value: '0' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-settings-save');
  await v.rerender();
  const post = v.posts.find((p) => p.path.endsWith('/settings'));
  assert.deepEqual(post.body.patch.tickets, { maxWorking: 6, stallMinutes: 20, archiveHours: 0 });
  assert.deepEqual(post.body.patch.topics, { idleHours: 6, maxContextK: 128 });
  assert.equal('dispatcher' in post.body.patch, false, 'there is no dispatcher mode to save');
  v.hooks.runCleanups();
});

test('the router notice shows once, opens the dispatcher, and is dismissed through its route', async () => {
  await withTaskState({ state: { routerNoticePending: true } }, async () => {
    const { exports, hooks } = await loadClient();
    const { ctx, seen } = fakeContext();
    exports.apply(ctx);
    const posts = mockFetch();
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    let tree = await renderSettled(panel, {}, hooks);
    const [notice] = findAll(tree, (n) => n.props['data-dsh-bots-router-notice']);
    assert.ok(notice);
    const words = collect(notice).join(' ');
    assert.match(words, /Your dispatcher now hands out the work/);
    assert.match(words, /turn that ability on under Abilities on its profile/);
    // Two sentences: what changed, and where to switch back.
    for (const lang of ['en', 'zh']) assert.equal(seen.locale.dict[lang].routerNoticeBody.split(/(?<=[.。])\s*/).filter(Boolean).length, 2, lang);
    click(tree, 'data-dsh-bots-router-notice-open');
    hooks.rewind();
    tree = panel({});
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-tab'] === 'profile')[0].props['data-active'], true);
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-detail'] === 'bot-a').length, 1);
    click(tree, 'data-dsh-bots-router-notice-dismiss');
    await flush();
    hooks.rewind();
    tree = panel({});
    assert.ok(posts.some((p) => p.path === '/__dsh_bots/router-notice/dismiss'));
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-router-notice']).length, 0);
    hooks.runCleanups();
  });
  // Without the flag: no notice.
  const v = await openView('data-dsh-bots-usage-entry');
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-notice']).length, 0);
  v.hooks.runCleanups();
});

test('a team hired before its lead existed is offered it once: Add hires it, No thanks dismisses it', async () => {
  const offer = { team: 'opc', name: { en: 'One-person company', zh: '一人公司' }, lead: { key: 'ops', handle: 'compass', name: { en: 'Compass', zh: 'Compass 运营' }, bio: { en: 'Operations lead: keeps the plan.', zh: '运营负责人：定计划。' }, color: '#7c5cff', tasks: [{ en: 'Inbox sweep', zh: '收件箱巡检' }, { en: 'Weekly numbers', zh: '每周数据' }] } };
  for (const [button, path, body] of [
    ['data-dsh-bots-lead-offer-add', '/__dsh_bots/teams/add-lead', { team: 'opc', lang: 'en' }],
    ['data-dsh-bots-lead-offer-dismiss', '/__dsh_bots/teams/add-lead/dismiss', { team: 'opc' }],
  ]) {
    await withTaskState({ state: { leadOffers: [offer] } }, async () => {
      const { exports, hooks } = await loadClient();
      const { ctx, seen } = fakeContext();
      exports.apply(ctx);
      const posts = mockFetch();
      const panel = seen.slots.find((s) => s.options.name === 'main').component;
      let tree = await renderSettled(panel, {}, hooks);
      const [notice] = findAll(tree, (n) => n.props['data-dsh-bots-lead-offer'] === 'opc');
      assert.match(collect(notice).join(' '), /One-person company now has a lead/);
      assert.match(collect(notice).join(' '), /Compass: Operations lead: keeps the plan\. It runs the team's routines \(Inbox sweep, Weekly numbers\) in place of the dispatcher/);
      click(tree, button, 'opc');
      await flush();
      await flush();
      hooks.rewind();
      tree = panel({});
      assert.deepEqual(posts.find((p) => p.path === path)?.body, body);
      assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-lead-offer']).length, 0, 'gone at once');
      hooks.runCleanups();
    });
  }
});

test('the old-leads notice names the leads, and Remove deletes them before it is dismissed', async () => {
  await withTaskState({ state: { oldLeads: [{ id: 'bot-b', name: 'Bob', handle: 'bob', team: 'opc' }] } }, async () => {
    const { exports, hooks } = await loadClient();
    const { ctx, seen } = fakeContext();
    exports.apply(ctx);
    const posts = mockFetch();
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    let tree = await renderSettled(panel, {}, hooks);
    const [notice] = findAll(tree, (n) => n.props['data-dsh-bots-old-leads']);
    assert.match(collect(notice).join(' '), /Ada hands out the work of every team, so Bob \(@bob\), hired as a team lead/);
    click(tree, 'data-dsh-bots-old-leads-remove');
    await flush();
    await flush();
    hooks.rewind();
    tree = panel({});
    const sent = posts.map((p) => p.path);
    assert.ok(sent.indexOf('/__dsh_bots/delete') >= 0 && sent.indexOf('/__dsh_bots/delete') < sent.indexOf('/__dsh_bots/lead-notice/dismiss'));
    assert.deepEqual(posts.find((p) => p.path === '/__dsh_bots/delete').body, { id: 'bot-b' });
    assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-old-leads']).length, 0);
    hooks.runCleanups();
  });
});

test('usage: a by-task table, and the old task counts read as runs', async () => {
  USAGE.tickets = [{ id: 'tquestion', title: 'Which logo do you prefer?', bot: 'bot-b', stage: 'question', runs: 2, tokens: 15_000, cost: { USD: 0.025 } }];
  USAGE.tasks[1].ticket = 'tworking1';
  try {
    const v = await openView('data-dsh-bots-usage-entry');
    const text = collect(v.tree).join(' ');
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-tile'] === 'runs')[0]).join(' '), /Runs 7/);
    assert.match(text, /Recent runs/);
    assert.match(text, /By task/);
    assert.doesNotMatch(text, /Recent tasks/);
    const bots = findAll(v.tree, (n) => n.props['data-dsh-bots-usage-bots'])[0];
    assert.match(collect(bots.children.find((c) => c.type === 'thead')).join(' '), /Bot Runs Tokens Cost/);
    const [row] = findAll(v.tree, (n) => n.props['data-dsh-bots-usage-ticket'] === 'tquestion');
    assert.match(collect(row).join(' '), /Which logo do you prefer\? Needs your answer Bob 2 15K \$0\.025/);
    // A run that belongs to a task links to it; a task row opens it.
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-usage-run-task'] === 'tworking1').length, 1);
    row.props.onClick();
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
    v.hooks.runCleanups();
  } finally {
    delete USAGE.tickets;
    delete USAGE.tasks[1].ticket;
  }
  // zh: runs are 回合, by task is 按任务.
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const zh = seen.locale.dict.zh;
  assert.equal(zh.tileRuns, '回合');
  assert.equal(zh.recentRuns, '最近的回合');
  assert.equal(zh.byTask, '按任务');
  assert.equal(zh.tasks, '任务');
});

test('chat: a delegation is one line that opens its task; a report shows its status', async () => {
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm6', from: 'bot-a', to: 'bot-b', text: 'Draw two logos and ask Kada', at: Date.now() - 4_000, kind: 'dm', ticket: 'tquestion' },
      { id: 'm7', from: 'bot-b', to: 'bot-a', text: 'Blue or green?', at: Date.now() - 2_000, kind: 'dm', ticket: 'tquestion', status: 'question' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    await v.rerender();
    const [card] = findAll(v.tree, (n) => n.props['data-dsh-bots-task-card'] === 'tquestion');
    assert.ok(card, 'the delegation is a row that links to its task');
    const words = collect(card).join(' ');
    assert.match(words, /^AD Ada .*Bob Which logo do you prefer\? Needs your answer \d/, 'who to whom, the title from the Host, its stage, the time');
    assert.equal(card.type, 'button');
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-report']).map((n) => n.props['data-dsh-bots-report']), ['question']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-task-card']).length, 1, 'a report is not a second card');
    card.props.onClick({ stopPropagation() {} });
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
    // The activity view marks the same two messages.
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-event-task']).map((n) => n.props['data-dsh-bots-event-task']), ['tquestion', 'tquestion']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-report'] === 'question').length, 1);
    v.hooks.runCleanups();
  });
});

test('the conversation: bot_send_message shows the task it opened, a report its status; a task conversation’s badge opens the task', async () => {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  mockFetch();
  const view = seen.slots.find((s) => s.options.name === 'tool.call.toolview' && s.options.key === 'bot_send_message').component;
  const meta = { to: { id: 'bot-b', name: 'Bob', handle: 'bob', avatar: BOTS[1].avatar }, from: { id: 'bot-a', name: 'Ada', handle: 'ada', avatar: BOTS[0].avatar }, ticket: { id: 'tqueued01', title: 'Translate the docs' }, stage: 'queued' };
  hooks.reset();
  let tree = view({ phase: 'result', block: { callId: 'c2', call: { argsRaw: '{"to":"@bob","text":"Translate the docs into German"}' }, content: [{ type: 'text', text: 'Task tqueued01 opened' }], isError: false, meta } });
  const [card] = findAll(tree, (n) => n.props['data-dsh-bots-task-card'] === 'tqueued01');
  assert.match(collect(card).join(' '), /Translate the docs .*Task · Bob .*Queued/);
  card.props.onClick({ stopPropagation() {} });
  assert.deepEqual(seen.selected, ['bots'], 'it opens the panel on the task');
  hooks.reset();
  tree = view({ phase: 'result', block: { callId: 'c3', call: { argsRaw: '{"status":"done","text":"All translated."}' }, content: [], isError: false, meta: { from: meta.to, ticket: 'tqueued01' } } });
  assert.match(collect(tree).join(' '), /Report/);
  assert.deepEqual(findAll(tree, (n) => n.props['data-dsh-bots-report']).map((n) => n.props['data-dsh-bots-report']), ['done']);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-task-card']).length, 0);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-report-task'] === 'tqueued01').length, 1);

  const badge = seen.slots.find((s) => s.options.name === 'conversation.session.header.utilities').component;
  hooks.reset();
  badge({ sessionId: 'ticket-tquestion' });
  await flush();
  await flush();
  hooks.rewind();
  const b = badge({ sessionId: 'ticket-tquestion' });
  assert.equal(b.props['data-dsh-bots-badge'], 'bot-b', 'the bot from the task when the session map lacks it');
  assert.equal(b.props['data-dsh-bots-badge-task'], 'tquestion');
  assert.match(b.props.title, /A task of Bob: Which logo do you prefer\?/);
  b.props.onClick();
  assert.deepEqual(seen.selected, ['bots', 'bots']);
  hooks.runCleanups();
});

// --- what the Host emits since the Thread routing (PLAN-0.8 §13) -------------------------------

test('a dispatcher alone works by itself: no router-only tools or notice until the team has a teammate', async () => {
  await withTaskState({ state: { routerActive: false, routerNoticePending: true }, bots: [{ tools: { deny: [] } }] }, async () => {
    const v = await openTab('profile', 'bot-a');
    // Alone, it keeps every tool: nothing is marked off for a router, and no light-model hint.
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off'] || n.props['data-dsh-bots-router-allowed'] || n.props['data-dsh-bots-router-tool']).length, 0);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ability'] === 'code')[0].props['data-on'], true);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 0);
    assert.doesNotMatch(collect(v.tree).join(' '), /As the dispatcher it does not search the web, run commands/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-notice']).length, 0, 'the notice waits until it applies');
    v.hooks.runCleanups();
  });
  // With a teammate it routes: the router's view of its tools, and the notice.
  await withTaskState({ state: { routerActive: true, routerNoticePending: true }, bots: [{ tools: { deny: [] } }] }, async () => {
    const v = await openTab('profile', 'bot-a');
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-model-hint']).length, 1);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-router-off']).map((n) => n.props['data-dsh-bots-router-off']), ['code']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-router-notice']).length, 1);
    v.hooks.runCleanups();
  });
});

const TG1 = 'telegram:bot-a/tg1:42';
const TG2 = 'telegram:bot-a/tg1:77';
const SL = 'slack:bot-a/sl1:C042:1700000000.0001';
const DC = 'discord:bot-a/dc1:998877';

test('chat: with several chats in a turn, the plain reply says it reached none of them and each bot_reply names its chat', async () => {
  const now = Date.now();
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm10', from: 'user', to: 'bot-a', text: 'Book the flights', at: now - 9_000, kind: 'user', via: 'telegram', who: 'Kada', thread: TG1 },
      { id: 'm11', from: 'user', to: 'bot-a', text: 'Book the hotel', at: now - 8_500, kind: 'user', via: 'telegram', who: 'Lin', thread: TG2 },
      { id: 'm12', from: 'user', to: 'bot-a', text: 'And the car', at: now - 8_000, kind: 'user', via: 'slack', who: 'Bob', thread: SL },
      { id: 'm13', from: 'bot-a', to: 'user', text: 'All three are on their way.', at: now - 7_000, kind: 'reply', thread: 'panel:sess-a', notSent: true, choices: [TG1, TG2, SL, DC] },
      { id: 'm14', from: 'bot-a', to: 'user', text: 'Flights booked.', at: now - 6_000, kind: 'reply', via: 'telegram', thread: TG1 },
      { id: 'm15', from: 'bot-a', to: 'user', text: 'Hotel booked.', at: now - 5_500, kind: 'reply', via: 'telegram', thread: TG2 },
      { id: 'm16', from: 'bot-a', to: 'user', text: 'Car booked.', at: now - 5_000, kind: 'reply', via: 'slack', thread: SL },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    // Two chats of the same app keep their own headers, so every answer shows where it went.
    const marks = findAll(v.tree, (n) => n.props['data-dsh-bots-via']).map((n) => collect(n).join(''));
    assert.deepEqual(marks, ['Telegram · Kada', 'Telegram · Lin', 'Slack · Bob', '→ Telegram · Kada', '→ Telegram · Lin', '→ Slack · Bob · thread']);
    const notSent = findAll(v.tree, (n) => n.props['data-dsh-bots-not-sent']);
    assert.equal(notSent.length, 1);
    // A chat nobody in the timeline wrote from reads by its id.
    assert.equal(collect(notSent[0]).join(''), 'Not sent to any chat: this turn involved several (Telegram · Kada, Telegram · Lin, Slack · Bob · thread, Discord · 998877).');
    // The activity view marks the same.
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-not-sent']);
    assert.equal(collect(badge).join(''), 'Not sent');
    assert.equal(badge.props.title, 'Telegram · Kada, Telegram · Lin, Slack · Bob · thread, Discord · 998877');
    const sent = findAll(v.tree, (n) => n.props['data-dsh-bots-event'] === 'reply' && findAll(n, (x) => x.props['data-dsh-bots-via']).length).map((n) => collect(findAll(n, (x) => x.props['data-dsh-bots-via'])[0]).join(''));
    assert.deepEqual(sent, ['Slack · Bob · thread', 'Telegram · Lin', 'Telegram · Kada']);
    v.hooks.runCleanups();
  });
});

test('chat: a turn the model could not finish shows the Host’s notice in the error colour, and the activity view marks it failed (0.16.1)', async () => {
  const now = Date.now();
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm17', from: 'user', to: 'bot-a', text: 'Plan the release', at: now - 9_000, kind: 'user', thread: 'panel:sess-a' },
      { id: 'm18', from: 'bot-a', to: 'user', chat: 'bot-a', text: "Couldn't reply: the model call failed (Connection error.). Send it again in a moment.", at: now - 8_000, kind: 'reply', error: 'Connection error.', thread: 'panel:sess-a' },
      { id: 'm19', from: 'bot-a', to: 'user', chat: 'bot-a', text: 'Here is the plan.', at: now - 7_000, kind: 'reply', thread: 'panel:sess-a' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-a');
    const failed = findAll(v.tree, (n) => n.props['data-dsh-bots-turn-failed']);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].props['data-dsh-bots-turn-failed'], 'm18');
    assert.match(collect(failed[0]).join(''), /Connection error\./);
    // The notice is no Markdown answer; an ordinary answer keeps its body.
    const row = (id) => findAll(v.tree, (n) => n.props['data-dsh-bots-msg-id'] === id)[0];
    assert.equal(findAll(row('m18'), (n) => n.props['data-dsh-bots-reply-text']).length, 0);
    assert.equal(findAll(row('m19'), (n) => n.props['data-dsh-bots-reply-text']).length, 1);
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-turn-failed']);
    assert.equal(collect(badge).join(''), 'Failed');
    assert.equal(badge.props.title, 'Connection error.');
    v.hooks.runCleanups();
  });
});

test('chat: a follow-up that went straight to a task links to it; a stuck or failed notice shows the task’s stage', async () => {
  const now = Date.now();
  await withFixtures(() => {
    MESSAGES.push(
      { id: 'm20', from: 'user', to: 'bot-b', text: 'Green, please', at: now - 6_000, kind: 'user', via: 'telegram', who: 'Kada', thread: TG1, ticket: 'tquestion' },
      { id: 'm21', from: 'bot-b', to: 'bot-a', text: 'Task tworking1 stalled: no report after a status check.', at: now - 4_000, kind: 'dm', ticket: 'tworking1', status: 'stalled' },
      { id: 'm22', from: 'bot-b', to: 'bot-a', text: 'Task tfailed01 failed: Connection refused (3 tries).', at: now - 3_000, kind: 'dm', ticket: 'tfailed01', status: 'failed' },
      // A task you asked for yourself: the notice is to you.
      { id: 'm23', from: 'bot-c', to: 'user', text: 'Task tstalled1 stalled: no report after a status check.', at: now - 2_000, kind: 'dm', ticket: 'tstalled1', status: 'stalled' },
    );
  }, async () => {
    const v = await openTab('chat', 'bot-b');
    await v.rerender();
    const [link] = findAll(v.tree, (n) => n.props['data-dsh-bots-report-task'] === 'tquestion');
    assert.equal(collect(link).join(''), 'Went to its task');
    assert.match(link.props.title, /goes straight to that task/);
    // Notices: the stage of a task and a link to it, not a delegation card or a report.
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-stage']).map((n) => [n.props['data-dsh-bots-stage'], collect(n).join('')]), [['stalled', 'Stuck'], ['failed', 'Failed'], ['stalled', 'Stuck']]);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-task-card']).length, 0);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-report']).length, 0);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-report-task']).map((n) => n.props['data-dsh-bots-report-task']), ['tquestion', 'tworking1', 'tfailed01', 'tstalled1']);
    link.props.onClick();
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tquestion').length, 1);
    // The activity view shows the stages too.
    click(v.tree, 'data-dsh-bots-activity');
    await v.rerender();
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-stage']).map((n) => n.props['data-dsh-bots-stage']), ['stalled', 'failed', 'stalled']);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-event-task']).map((n) => n.props['data-dsh-bots-event-task']), ['tstalled1', 'tfailed01', 'tworking1', 'tquestion']);
    v.hooks.runCleanups();
  });
});

// --- bot-to-bot detail, replies, live status -----------------------------------------------------

/** Patch the fixtures' state and bots for one test, then put them back. */
async function withLive(patch, fn) {
  const saved = { state: { ...STATE }, bots: BOTS.map((b) => ({ ...b })) };
  Object.assign(STATE, patch.state ?? {});
  (patch.bots ?? []).forEach((p, i) => p && Object.assign(BOTS[i], p));
  try {
    await fn();
  } finally {
    for (const k of Object.keys(STATE)) if (!(k in saved.state)) delete STATE[k];
    Object.assign(STATE, saved.state);
    BOTS.forEach((b, i) => {
      for (const k of Object.keys(b)) if (!(k in saved.bots[i])) delete b[k];
      Object.assign(b, saved.bots[i]);
    });
  }
}
const DELEGATIONS = () => {
  const now = Date.now();
  MESSAGES.push(
    { id: 'm30', from: 'bot-a', to: 'bot-b', text: 'Fix the login bug\nIt fails on Safari only; the cookie may lack SameSite.\nDeploy when green.', at: now - 5_000, kind: 'dm', ticket: 'tworking1' },
    { id: 'm31', from: 'bot-a', to: 'bot-c', text: 'Translate the docs into German.', at: now - 4_000, kind: 'dm', ticket: 'tqueued01' },
    { id: 'm32', from: 'bot-b', to: 'bot-a', text: 'Found the cause. The cookie had no SameSite flag.', at: now - 3_000, kind: 'dm', ticket: 'tworking1', status: 'progress' },
    { id: 'm33', from: 'bot-a', to: 'user', text: 'Two tasks are out: **Bob** fixes the login bug, 研究员 translates the docs.', at: now - 2_000, kind: 'reply' },
  );
};

test('chat: what bots say to each other runs as one compact group; Short adds two lines, Full the whole message and its task card', async () => {
  await withFixtures(DELEGATIONS, async () => {
    const v = await openTab('chat', 'bot-a');
    await v.rerender();
    // One line (the default): consecutive messages between bots are one group of rows, no nested task cards.
    let groups = findAll(v.tree, (n) => n.props['data-dsh-bots-traffic']);
    assert.deepEqual(groups.map((g) => [g.props['data-dsh-bots-traffic'], g.props['data-level']]), [[1, 'line'], [3, 'line']]);
    const rows = findAll(groups[1], (n) => n.props.className === 'dshb-tline');
    assert.deepEqual(rows.map((r) => collect(findAll(r, (n) => n.props['data-dsh-bots-subject'])[0]).join('')), ['Fix the login bug', 'Translate the docs', 'Found the cause.']);
    assert.equal(findAll(groups[1], (n) => n.props['data-dsh-bots-short']).length, 0);
    assert.equal(findAll(groups[1], (n) => n.props['data-dsh-bots-task-card']).length, 2, 'the rows themselves link to the tasks');
    assert.equal(findAll(groups[1], (n) => n.props['data-dsh-bots-task-card'] && n.type !== 'button').length, 0);
    assert.deepEqual(findAll(groups[1], (n) => n.props['data-dsh-bots-report']).map((n) => n.props['data-dsh-bots-report']), ['progress']);
    // The time shows once for a run in the same minute.
    assert.ok(findAll(groups[1], (n) => n.props.className === 'dshb-ttime').filter((n) => collect(n).join('') !== '').length <= 2);
    // A DM without a task unfolds where it is.
    const dm = findAll(groups[0], (n) => n.props['data-dsh-bots-expand'])[0];
    dm.props.onClick({ stopPropagation() {} });
    await v.rerender();
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-traffic'])[0]).join(' '), /Please write the code/);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-traffic'])[0].children[0].props['data-level'], 'full');
    // The reply to you is no box: full-strength text, as in the main conversation.
    const [reply] = findAll(v.tree, (n) => n.props['data-dsh-bots-reply-text']);
    assert.equal(reply.props.className, 'dshb-reply');
    assert.equal(reply.props.style, undefined);
    assert.match(source, /\.dshb-reply\{font-size:\$\{FONT\};line-height:1\.65;color:\$\{C\.primary\}/);
    v.hooks.runCleanups();
  });
  await withLive({ state: { display: { botMessages: 'short' } } }, () =>
    withFixtures(DELEGATIONS, async () => {
      const v = await openTab('chat', 'bot-a');
      await v.rerender();
      const group = findAll(v.tree, (n) => n.props['data-dsh-bots-traffic'])[1];
      assert.equal(group.props['data-level'], 'short');
      // The text's first lines under each row; the row names a title only when the text does not start with it.
      assert.deepEqual(findAll(group, (n) => n.props['data-dsh-bots-short']).map((n) => collect(n).join('').slice(0, 30)), ['Fix the login bug\nIt fails on ', 'Translate the docs into German', 'Found the cause. The cookie ha']);
      assert.deepEqual(findAll(group, (n) => n.props['data-dsh-bots-subject']).map((n) => collect(n).join('')), ['', '', '']);
      v.hooks.runCleanups();
    }),
  );
  await withLive({ state: { display: { botMessages: 'full' } } }, () =>
    withFixtures(DELEGATIONS, async () => {
      const v = await openTab('chat', 'bot-a');
      await v.rerender();
      const group = findAll(v.tree, (n) => n.props['data-dsh-bots-traffic'])[1];
      assert.equal(group.props['data-level'], 'full');
      // The task card is back for a delegation, and the whole text; a report links to its task.
      assert.deepEqual(findAll(group, (n) => n.props['data-dsh-bots-task-card']).map((n) => n.props['data-dsh-bots-task-card']), ['tworking1', 'tqueued01']);
      assert.match(collect(group).join(' '), /Deploy when green/);
      assert.deepEqual(findAll(group, (n) => n.props['data-dsh-bots-report-task']).map((n) => n.props['data-dsh-bots-report-task']), ['tworking1']);
      v.hooks.runCleanups();
    }),
  );
});

test('chat: a message added to a task opened earlier shows its own words, marked Added, not the task a second time', async () => {
  const ADDITIONS = () => {
    const now = Date.now();
    MESSAGES.push(
      { id: 'm40', from: 'bot-a', to: 'bot-b', text: 'Fix the login bug\nIt fails on Safari only.', at: now - 5_000, kind: 'dm', ticket: 'tworking1' },
      // Logged before the Host marked additions: told apart by coming after the task's opening.
      { id: 'm41', from: 'bot-a', to: 'bot-b', text: 'Check Firefox too. It may be the same cookie.', at: now - 4_000, kind: 'dm', ticket: 'tworking1' },
      { id: 'm42', from: 'bot-a', to: 'bot-b', text: 'The person says it is urgent.', at: now - 3_000, kind: 'dm', ticket: 'tworking1', added: true },
      { id: 'm43', from: 'bot-b', to: 'bot-a', text: 'Found the cause.', at: now - 2_000, kind: 'dm', ticket: 'tworking1', status: 'progress' },
    );
  };
  await withFixtures(ADDITIONS, async () => {
    const v = await openTab('chat', 'bot-a');
    await v.rerender();
    // One row is the task; the two additions name what was added, and the report stays a report.
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-task-card'] === 'tworking1').length, 1);
    const adds = findAll(v.tree, (n) => n.props['data-dsh-bots-added-task'] === 'tworking1');
    assert.deepEqual(adds.map((r) => collect(findAll(r, (n) => n.props['data-dsh-bots-subject'])[0]).join('')), ['Check Firefox too.', 'The person says it is urgent.']);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-added'] === 'tworking1').map((n) => collect(n).join('')), ['Added', 'Added']);
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-added-task'] && findAll(n, (c) => c.props['data-dsh-bots-live'] || c.props['data-dsh-bots-stage']).length > 0).length, 0, 'an addition carries no stage of its own');
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-report']).map((n) => n.props['data-dsh-bots-report']), ['progress']);
    // It opens its task.
    adds[0].props.onClick({ stopPropagation() {} });
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-ticket'] === 'tworking1').length, 1);
    v.hooks.runCleanups();
  });
  await withLive({ state: { display: { botMessages: 'full' } } }, () =>
    withFixtures(ADDITIONS, async () => {
      const v = await openTab('chat', 'bot-a');
      await v.rerender();
      // In full: the task card once, the added words in whole, and a link to the task.
      assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-task-card']).map((n) => n.props['data-dsh-bots-task-card']), ['tworking1']);
      assert.match(collect(v.tree).join(' '), /It may be the same cookie\./);
      assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-added-task'] === 'tworking1' && n.type === 'button').length, 2);
      v.hooks.runCleanups();
    }),
  );
});

test('chat: a task waiting for the person says it asks them, before what it last ran', async () => {
  const now = Date.now();
  const task = { kind: 'tool', tool: 'write', detail: 'SKILL.md', startedAt: now - 60_000, stepAt: now - 55_000, steps: 4, botId: 'bot-b', title: 'Fix the login bug' };
  const row = TICKETS.find((r) => r.id === 'tworking1');
  row.asking = true;
  try {
    for (const level of ['line', 'full']) {
      await withLive({ state: { at: now, taskActivity: { tworking1: task }, display: { botMessages: level } } }, () =>
        withFixtures(DELEGATIONS, async () => {
          const v = await openTab('chat', 'bot-a');
          await v.rerender();
          const [line] = findAll(v.tree, (n) => n.props.className === 'dshb-tline' && findAll(n, (c) => c.props['data-dsh-bots-task-asking'] === 'tworking1').length > 0);
          assert.ok(line, `${level}: the row says the task asks you`);
          assert.equal(findAll(line, (n) => n.props['data-dsh-bots-live'] === 'chip').length, 0, `${level}: not that it is still writing`);
          v.hooks.runCleanups();
        }),
      );
    }
  } finally {
    delete row.asking;
  }
});

test('settings: messages between bots take one of three levels and save with the rest', async () => {
  const v = await openView('data-dsh-bots-settings');
  assert.match(collect(v.tree).join(' '), /Messages between bots/);
  const choice = () => findAll(v.tree, (n) => n.props['data-dsh-bots-bot-messages']).map((n) => [n.props['data-dsh-bots-bot-messages'], n.props['data-active'], collect(n).join('')]);
  assert.deepEqual(choice(), [['line', true, 'One line'], ['short', false, 'Short'], ['full', false, 'Full']], 'one line when the Host has none');
  click(v.tree, 'data-dsh-bots-bot-messages', 'short');
  await v.rerender(1);
  assert.deepEqual(choice().map((c) => c[1]), [false, true, false]);
  assert.match(collect(v.tree).join(' '), /first two lines/);
  click(v.tree, 'data-dsh-bots-settings-save');
  await v.rerender();
  const post = v.posts.find((p) => p.path.endsWith('/settings'));
  assert.deepEqual(post.body.patch.display, { botMessages: 'short' });
  v.hooks.runCleanups();
});

test('live status: the working row, the list, the tasks and a delegation say what runs now, and its time ticks', async () => {
  const now = Date.now();
  const home = { kind: 'tool', tool: 'bash', detail: 'npm test', startedAt: now - 65_000, stepAt: now - 42_000, steps: 3 };
  const task = { kind: 'thinking', startedAt: now - 20_000, stepAt: now - 5_000, steps: 2, botId: 'bot-b', title: 'Fix the login bug' };
  await withLive({ state: { at: now, taskActivity: { tworking1: task } }, bots: [{ status: 'running', activity: home }, { status: 'idle', avatarPending: true }] }, () =>
    withFixtures(DELEGATIONS, async () => {
      const v = await openTab('chat', 'bot-a');
      await v.rerender();
      // The chat's working row: who, what it runs (the command set off as code), for how long, then the step and the turn's time.
      const [row] = findAll(v.tree, (n) => n.props['data-dsh-bots-working'] === 'bot-a');
      assert.ok(row);
      const words = collect(row).join('');
      assert.match(words, /^ADAdaRunning npm test · 4[23]s/);
      assert.match(words, /step 3 · 1m 0[56]s so far$/);
      assert.equal(collect(findAll(row, (n) => n.props.className === 'dshb-act-code')[0]).join(''), 'npm test');
      // The list: a bot at work says what it does; one working on a task says what the task does; a picture being drawn turns on its avatar.
      const rail = (id) => findAll(v.tree, (n) => n.props['data-dsh-bots-row'] === id)[0];
      assert.match(collect(findAll(rail('bot-a'), (n) => n.props['data-dsh-bots-row-live'] === 'home')[0]).join(''), /^Running npm test· 4[23]s$/);
      assert.match(collect(findAll(rail('bot-b'), (n) => n.props['data-dsh-bots-row-live'] === 'task')[0]).join(''), /^Thinking· [56]s$/);
      assert.equal(findAll(rail('bot-b'), (n) => n.props['data-dsh-bots-avatar-pending']).length, 1);
      assert.equal(findAll(rail('bot-b'), (n) => n.props['data-dsh-bots-status'] === 'running').length, 1, 'working on a task is working');
      // The delegation's stage is alive while its task runs.
      const [chip] = findAll(v.tree, (n) => n.props['data-dsh-bots-live'] === 'chip');
      assert.match(collect(chip).join(''), /^Thinking[56]s$/);
      // The Tasks view: the working task's last line.
      click(v.tree, 'data-dsh-bots-tasks-entry');
      await v.rerender();
      assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-task-live'] === 'tworking1')[0]).join(''), /^Thinking· [56]s$/);
      v.hooks.runCleanups();
    }),
  );
});

test('live words: each kind of tool reads as what it does, in English and Chinese', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const { en, zh } = seen.locale.dict;
  const acts = Object.keys(en).filter((k) => k.startsWith('act_'));
  assert.ok(acts.length >= 30);
  for (const k of [...acts, 'workingPlain', 'liveTotal', 'elapsedS', 'elapsedM', 'elapsedH', 'avatarDrawing', 'setChat', 'setBotMessages', 'botMessages_line', 'botMessages_short', 'botMessages_full', 'setBotMessagesHint_line', 'setBotMessagesHint_short', 'setBotMessagesHint_full']) {
    assert.ok(zh[k] && zh[k] !== en[k], `zh ${k}`);
    if (/\{detail\}/.test(en[k])) assert.match(zh[k], /\{detail\}/, `zh ${k} keeps the detail`);
  }
  // Every kind of tool the client names has its words.
  for (const id of ['run', 'read', 'edit', 'write', 'find', 'search', 'fetch', 'helper', 'skill', 'memory', 'recall']) assert.ok(en[`act_${id}`] && en[`act_${id}_bare`], id);
  for (const id of ['delegate', 'followup', 'report', 'ask', 'draw', 'remember', 'reply', 'team', 'schedule', 'plan', 'job', 'office', 'tool', 'thinking', 'writing']) assert.ok(en[`act_${id}`], id);
});

test('task words: every stage, report status and action has English and Chinese', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const { en, zh } = seen.locale.dict;
  const keys = [
    ...['question', 'failed', 'stalled', 'queued', 'working', 'done', 'stopped'].map((s) => `stage_${s}`),
    ...['progress', 'done', 'blocked', 'question'].map((s) => `report_${s}`),
    ...['stop', 'retry', 'close'].map((a) => `taskDid_${a}`),
    'kind_report',
    ...['notSent', 'notSentChats', 'threadPart', 'threadTopic', 'followUpTask', 'followUpHint'],
  ];
  for (const k of keys) {
    assert.ok(en[k], `en ${k}`);
    assert.ok(zh[k] && zh[k] !== en[k], `zh ${k}`);
  }
  // The screen says task, never ticket.
  for (const [k, v] of Object.entries(en)) assert.doesNotMatch(String(v), /ticket/i, k);
  for (const [k, v] of Object.entries(zh)) assert.doesNotMatch(String(v), /ticket|工单/i, k);
});

// --- questions a bot asks (ask_user_question) -------------------------------------------------------

const DB_ASK = { id: 'ask-1', botId: 'bot-a', sessionId: 'sess-a', at: Date.now(), questions: [{ id: 'db', question: 'Which database?', header: 'Storage', detail: 'For the launch site.', options: [{ label: 'Postgres', description: 'A server.' }, { label: 'SQLite' }] }] };
/** The panel with some questions waiting (state `asks`), and what it posted; `answer` replies to the answer route. */
async function withAsks({ asks, rows = {}, answer = () => ({ ok: true }) }, fn) {
  const saved = { asks: STATE.asks, asking: BOTS.map((b) => b.asking), rows: TICKETS.map((r) => r.asking) };
  STATE.asks = asks;
  BOTS.forEach((b) => (b.asking = asks.filter((a) => a.botId === b.id && !a.ticketId).length));
  TICKETS.forEach((r) => (r.asking = rows[r.id]));
  try {
    const { exports, hooks } = await loadClient();
    const { ctx, seen } = fakeContext();
    exports.apply(ctx);
    const posts = mockFetch();
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => (/\/asks\/[^/]+\/answer$/.test(String(url)) ? (posts.push({ path: String(url), body: JSON.parse(init.body) }), { ok: true, json: async () => answer() }) : inner(url, init));
    const panel = seen.slots.find((s) => s.options.name === 'main').component;
    const v = { hooks, posts, seen, tree: await renderSettled(panel, {}, hooks) };
    v.rerender = async (n = 3) => {
      for (let i = 0; i < n; i += 1) {
        hooks.rewind();
        v.tree = panel({});
        await flush();
      }
      hooks.rewind();
      v.tree = panel({});
      return v.tree;
    };
    await fn(v);
    hooks.runCleanups();
  } finally {
    STATE.asks = saved.asks;
    if (saved.asks === undefined) delete STATE.asks;
    BOTS.forEach((b, i) => (saved.asking[i] === undefined ? delete b.asking : (b.asking = saved.asking[i])));
    TICKETS.forEach((r, i) => (saved.rows[i] === undefined ? delete r.asking : (r.asking = saved.rows[i])));
  }
}
const askCard = (tree, id) => findAll(tree, (n) => n.props['data-dsh-bots-ask'] === id)[0];
const askOption = (tree, label) => findAll(tree, (n) => n.props['data-dsh-bots-ask-option'] === label)[0];

test('questions: the bot\'s chat shows its question, one click answers it, and it leaves with the next state', async () => {
  await withAsks({ asks: [DB_ASK] }, async (v) => {
    const [badge] = findAll(v.tree, (n) => n.props['data-dsh-bots-row-asking'] !== undefined);
    assert.equal(badge.props['data-dsh-bots-row-asking'], 1);
    assert.equal(badge.props['aria-label'], '1 waiting for your answer');
    const card = askCard(v.tree, 'ask-1');
    const text = collect(card).join(' ');
    for (const s of ['Ada is asking you', 'Storage', 'Which database?', 'For the launch site.', 'Postgres', 'A server.', 'SQLite']) assert.ok(text.includes(s), s);
    assert.equal(findAll(card, (n) => n.props['data-dsh-bots-ask-submit']).length, 0, 'one single choice needs no Submit');
    assert.equal(askOption(card, 'SQLite').props.role, undefined);
    askOption(v.tree, 'Postgres').props.onClick();
    await v.rerender(0);
    assert.equal(askOption(v.tree, 'Postgres').props.disabled, true, 'disabled while posting');
    delete STATE.asks;
    await v.rerender();
    assert.deepEqual(v.posts.filter((p) => p.path.includes('/asks/')), [{ path: '/__dsh_bots/asks/ask-1/answer', body: { answers: [{ id: 'db', selected: ['Postgres'] }] } }]);
    assert.equal(askCard(v.tree, 'ask-1'), undefined, 'answered: gone');
  });
  // Your own words go as `custom`; a refusal shows its reason and the card stays.
  await withAsks({ asks: [DB_ASK], answer: () => ({ ok: false, reason: 'the question is no longer waiting for an answer' }) }, async (v) => {
    const [other] = findAll(v.tree, (n) => n.props['data-dsh-bots-ask-other'] === 'db');
    assert.equal(other.props.placeholder, 'Or type your own answer');
    other.props.onChange({ target: { value: ' DuckDB ' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-ask-send'] === 'db')[0].props.onClick();
    await v.rerender();
    assert.deepEqual(v.posts.at(-1).body, { answers: [{ id: 'db', selected: [], custom: 'DuckDB' }] });
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-ask-error'])[0]).join(''), /no longer waiting/);
    assert.ok(askCard(v.tree, 'ask-1'));
  });
});

test('approvals: a tool waiting for approval says so on its task, and is allowed once or rejected from the panel', async () => {
  const approval = { id: 'ask-9', botId: 'bot-b', sessionId: 'ticket-tworking1', ticketId: 'tworking1', at: Date.now(), native: true, approval: { tool: 'write', callId: 'c1', display: { en: 'Write SKILL.md outside the workspace', zh: '在工作区外写入 SKILL.md' } }, questions: [{ id: 'c1', question: 'Write SKILL.md outside the workspace' }] };
  const row = TICKETS.find((r) => r.id === 'tworking1');
  row.askingApproval = true;
  try {
    await withAsks({ asks: [approval], rows: { tworking1: true } }, async (v) => {
      click(v.tree, 'data-dsh-bots-tasks-entry');
      await v.rerender();
      assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-task-asking'] === 'tworking1')[0]).join(''), /Needs your approval/);
      click(v.tree, 'data-dsh-bots-task', 'tworking1');
      await v.rerender();
      const card = askCard(v.tree, 'ask-9');
      assert.match(collect(card).join(' '), /Bob is waiting for your approval .*Write SKILL\.md outside the workspace .*Tool: write .*Allowing it lets this one call go ahead/);
      assert.equal(findAll(card, (n) => n.props['data-dsh-bots-ask-option'] !== undefined || n.props['data-dsh-bots-ask-other'] !== undefined).length, 0, 'no options or free text');
      click(v.tree, 'data-dsh-bots-approval-allow', 'ask-9');
      await v.rerender(1);
      assert.match(v.posts.at(-1).path, /\/asks\/ask-9\/answer$/);
      assert.deepEqual(v.posts.at(-1).body, { outcome: 'allowed-once' });
      click(v.tree, 'data-dsh-bots-approval-reject', 'ask-9');
      await v.rerender(1);
      assert.deepEqual(v.posts.at(-1).body, { outcome: 'rejected' });
    });
  } finally {
    delete row.askingApproval;
  }
});

test('questions: a task\'s question puts it under Needs you; several questions are ticked and submitted; an approval opens the conversation', async () => {
  const taskAsk = { id: 'ask-2', botId: 'bot-b', sessionId: 'ticket-tworking1', ticketId: 'tworking1', at: Date.now(), continued: true, questions: [{ id: 'tools', question: 'Which checks?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Test' }] }, { id: 'name', question: 'Name the release?' }] };
  const approval = { id: 'ask-3', botId: 'bot-a', sessionId: 'sess-a', at: Date.now(), native: true, questions: [{ id: 'perm', question: 'Allow rm -rf build?' }] };
  await withAsks({ asks: [taskAsk, approval], rows: { tworking1: true } }, async (v) => {
    // The home's approval: answered in the conversation.
    const native = askCard(v.tree, 'ask-3');
    assert.match(collect(native).join(' '), /Ada is waiting for you in the conversation .*Allow rm -rf build\? .*Answer this one in the conversation\./);
    assert.equal(findAll(native, (n) => n.props['data-dsh-bots-ask-option'] !== undefined || n.props['data-dsh-bots-ask-other'] !== undefined).length, 0);
    click(v.tree, 'data-dsh-bots-ask-open', 'sess-a');
    assert.deepEqual(v.seen.opened, ['sess-a']);
    assert.equal(askCard(v.tree, 'ask-2'), undefined, 'a task\'s question is not in the home chat');
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-row-asking'] !== undefined).map((n) => n.props['data-dsh-bots-row-asking']), [1], 'only Ada\'s row: Bob\'s question is a task\'s');
    // The task needs you, and says why.
    click(v.tree, 'data-dsh-bots-tasks-entry');
    await v.rerender();
    const needs = findAll(v.tree, (n) => n.props['data-dsh-bots-task-group'] === 'needs')[0];
    assert.ok(findAll(needs, (n) => n.props['data-dsh-bots-task'] === 'tworking1').length === 1);
    assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-task-asking'] === 'tworking1')[0]).join(''), /Asks you/);
    click(v.tree, 'data-dsh-bots-task', 'tworking1');
    await v.rerender();
    const card = askCard(v.tree, 'ask-2');
    assert.match(collect(card).join(' '), /Bob is asking you .*Choose all that apply/);
    assert.match(collect(card).join(' '), /Bob went on with other work; your answer still reaches it\./);
    const submit = () => findAll(v.tree, (n) => n.props['data-dsh-bots-ask-submit'] === 'ask-2')[0];
    assert.equal(submit().props.disabled, true, 'every question needs an answer');
    assert.equal(askOption(v.tree, 'Lint').props.role, 'checkbox');
    askOption(v.tree, 'Lint').props.onClick();
    await v.rerender(1);
    askOption(v.tree, 'Test').props.onClick();
    await v.rerender(1);
    assert.equal(askOption(v.tree, 'Test').props['aria-checked'], true);
    const [free] = findAll(v.tree, (n) => n.props['data-dsh-bots-ask-other'] === 'name');
    assert.equal(free.props.placeholder, 'Type your answer');
    free.props.onChange({ target: { value: 'Apollo' } });
    await v.rerender(1);
    assert.equal(submit().props.disabled, false);
    submit().props.onClick();
    await v.rerender();
    assert.deepEqual(v.posts.filter((p) => p.path.includes('/asks/')), [{ path: '/__dsh_bots/asks/ask-2/answer', body: { answers: [{ id: 'tools', selected: ['Lint', 'Test'] }, { id: 'name', selected: [], custom: 'Apollo' }] } }]);
  });
});

// --- threads (PLAN-0.10 §2.2, §7) --------------------------------------------------------------

const T0 = Date.now() - 20 * MIN;
const SEARCHING = { kind: 'tool', tool: 'web_search', detail: 'Shanghai hukou 2026', startedAt: Date.now() - 30_000, stepAt: Date.now() - 8_000, steps: 2 };
const BOB_ANSWER = 'Beijing permit: three conditions.\nA degree and a contract.\nSocial insurance in Beijing.';
/** The replies in the thread under the Beijing message: yours, then Bob's answer from his task, each with the message it quotes. */
const beijingReplies = () => [
  { id: 'pq1haidia', from: 'user', to: 'bot-a', chat: 'bot-a', text: 'Does Haidian differ?', at: T0 + 2 * MIN, kind: 'user', topic: 'pbeijing1', thread: 'panel:sess-a:pbeijing1', quote: { id: 'pbeijing1', from: 'user', text: 'Look up the Beijing work residence permit' } },
  { id: 'r2', from: 'bot-b', to: 'user', chat: 'bot-a', text: BOB_ANSWER, at: T0 + 5 * MIN, kind: 'reply', topic: 'pbeijing1', thread: 'panel:sess-a:pbeijing1', ticket: 'tdone0001', status: 'done', quote: { id: 'pq1haidia', from: 'user', text: 'Does Haidian differ?' } },
];
/** Ada's chat as the Host lists it: as it was said, the bots' answers and the thread's replies among the rest. */
const mainItems = () => [
  { id: 'm-old', from: 'user', to: 'bot-a', text: 'Plan the launch', at: T0 - 5 * MIN, kind: 'user' },
  { id: 'pbeijing1', from: 'user', to: 'bot-a', chat: 'bot-a', text: 'Look up the Beijing work residence permit', at: T0, kind: 'user', thread: 'panel:sess-a' },
  { id: 'r1', from: 'bot-a', to: 'user', chat: 'bot-a', text: 'On it: I opened a task for Bob.', at: T0 + 20_000, kind: 'reply', thread: 'panel:sess-a' },
  ...beijingReplies(),
  { id: 'general', from: 'bot-a', to: 'user', chat: 'bot-a', text: 'Morning, all quiet otherwise.', at: T0 + 7 * MIN, kind: 'reply', thread: 'panel:sess-a' },
];
const CHAT_IDS = ['m-old', 'pbeijing1', 'r1', 'pq1haidia', 'r2', 'general'];
const threadSummaries = () => ({
  pbeijing1: { key: 'panel:sess-a:pbeijing1', count: 2, lastAt: T0 + 5 * MIN, last: { from: 'bot-b', text: BOB_ANSWER }, unread: 1, running: false, tickets: [ticketRow('tdone0001', 'bot-b', 'done', 'Beijing work residence permit')] },
  r1: { key: 'panel:sess-a:r1', count: 0, lastAt: 0, last: null, unread: 0, running: true, tickets: [ticketRow('tworking1', 'bot-b', 'working', 'Shanghai hukou rules', { activity: SEARCHING })] },
});
/**
 * Ada's chat served as the Host of PLAN-0.10 does: `?bot=` the chat as said and the thread summaries,
 * `&topic=` a thread (its root and replies); POST /send answers with the Host's copy (queued), and
 * POST /threads/seen marks the thread read. `send` overrides the answer to /send.
 */
async function threadsChat({ items = mainItems(), replies = { pbeijing1: beijingReplies() }, threads = threadSummaries(), send, services, state } = {}) {
  const { exports, hooks } = await loadClient();
  const { ctx, seen } = fakeContext({ services });
  exports.apply(ctx);
  const posts = mockFetch();
  const base = globalThis.fetch;
  const gets = [];
  const host = { items, replies, threads, state };
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST' && path.endsWith('/send')) {
      const body = JSON.parse(init.body);
      posts.push({ path, body });
      n += 1;
      const inThreadOf = (id) => Object.entries(host.replies).find(([, list]) => list.some((m) => m.id === id))?.[0];
      const topic = body.replyTo ? inThreadOf(body.replyTo) || body.replyTo : '';
      const message = { id: `psent000${n}`, from: 'user', to: 'bot-a', chat: 'bot-a', kind: 'user', text: body.text, at: Date.now(), ...(topic ? { topic } : {}), ...(body.replyTo && body.replyTo !== topic ? { replyTo: body.replyTo } : {}), pending: true };
      const r = send ? send(body) : { ok: true, sessionId: 'sess-a', message };
      return { ok: true, json: async () => r };
    }
    if (init?.method === 'POST' && path.endsWith('/threads/seen')) {
      const body = JSON.parse(init.body);
      posts.push({ path, body });
      if (host.threads[body.root]) host.threads = { ...host.threads, [body.root]: { ...host.threads[body.root], unread: 0 } };
      return { ok: true, json: async () => ({ ok: true, unread: 0 }) };
    }
    if (path.startsWith('/__dsh_bots/state') && host.state) return { ok: true, json: async () => ({ ...STATE, ...host.state }) };
    if (path.startsWith('/__dsh_bots/messages')) {
      gets.push(path);
      const topic = new URL(path, 'http://x').searchParams.get('topic');
      const list = topic ? [...host.items.filter((m) => m.id === topic), ...(host.replies[topic] ?? []).map(({ quote, ...m }) => m)] : host.items;
      const threads = topic ? (host.threads[topic] ? { [topic]: host.threads[topic] } : {}) : host.threads;
      return { ok: true, json: async () => ({ items: list, threads }) };
    }
    return base(url, init);
  };
  const panel = seen.slots.find((s) => s.options.name === 'main').component;
  let tree = await renderSettled(panel, {}, hooks);
  const rerender = async (k = 3) => {
    for (let i = 0; i < k; i += 1) {
      hooks.rewind();
      tree = panel({});
      await flush();
    }
    hooks.rewind();
    tree = panel({});
    return tree;
  };
  await rerender();
  return { hooks, posts, gets, host, seen, get tree() { return tree; }, rerender };
}
const attrs = (tree, attr) => findAll(tree, (n) => n.props[attr] !== undefined).map((n) => n.props[attr]);
const pane = (tree) => findAll(tree, (n) => n.props['data-dsh-bots-thread-pane'] !== undefined)[0];
const mainOf = (tree) => findAll(tree, (n) => n.props['data-dsh-bots-thread'] === 'bot-a')[0];

test('threads: the chat lists a reply where it was said, quoting what it answers unless that is just above; a message with a thread gets a link', async () => {
  // Bob's answer later in the thread, after the chat moved on: it quotes again.
  const late = { id: 'r3', from: 'bot-b', to: 'user', chat: 'bot-a', text: 'Chaoyang is the same.', at: T0 + 9 * MIN, kind: 'reply', topic: 'pbeijing1', thread: 'panel:sess-a:pbeijing1', quote: { id: 'pq1haidia', from: 'user', text: 'Does Haidian differ?' } };
  const v = await threadsChat({ items: [...mainItems(), late] });
  const main = mainOf(v.tree);
  assert.deepEqual(attrs(main, 'data-dsh-bots-msg-id'), [...CHAT_IDS, 'r3']);
  // Your reply quotes the Beijing message; Bob's answer right under it goes without; his later one quotes you.
  assert.deepEqual(attrs(main, 'data-dsh-bots-quoted'), ['pbeijing1', 'pq1haidia']);
  const quoted = (id) => collect(findAll(main, (n) => n.props['data-dsh-bots-quoted'] === id)[0]).join('');
  assert.equal(quoted('pbeijing1'), 'You: Look up the Beijing work residence permit');
  assert.equal(quoted('pq1haidia'), 'You: Does Haidian differ?');
  const [mine] = findAll(main, (n) => n.props['data-dsh-bots-msg-id'] === 'pq1haidia');
  assert.match(collect(mine).join(' '), /Look up the Beijing work residence permit .*Does Haidian differ\?/);
  const [bob] = findAll(main, (n) => n.props['data-dsh-bots-msg-id'] === 'r3');
  assert.match(collect(bob).join(' '), /Bob .*Does Haidian differ\? .*Chaoyang is the same\./);
  // A link under a message with a thread: how many replies; one with no reply yet whose task works says it is replying.
  assert.deepEqual(attrs(main, 'data-dsh-bots-thread-bar'), ['pbeijing1', 'r1']);
  const bar = (id) => collect(findAll(main, (n) => n.props['data-dsh-bots-thread-bar'] === id)[0]).join(' ');
  assert.equal(bar('pbeijing1'), '3 replies');
  assert.equal(bar('r1'), 'Thread Replying…');
  assert.deepEqual(attrs(main, 'data-dsh-bots-thread-running'), ['r1']);
  // A quote opens its thread.
  click(v.tree, 'data-dsh-bots-quoted', 'pq1haidia');
  await v.rerender();
  assert.equal(pane(v.tree)?.props['data-dsh-bots-thread-pane'], 'pbeijing1');
  v.hooks.runCleanups();
});

test('threads: Reply quotes the message above the composer; what is sent shows at the end of the chat quoting it, and the next message goes to the chat', async () => {
  const v = await threadsChat();
  // Every message offers Reply (yours, the bots', a thread's).
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-reply-to'), CHAT_IDS);
  click(v.tree, 'data-dsh-bots-reply-to', 'general');
  await v.rerender(1);
  assert.equal(pane(v.tree), undefined);
  const quoteBar = () => findAll(v.tree, (n) => n.props['data-dsh-bots-quote'] !== undefined);
  assert.match(collect(quoteBar()[0]).join(' '), /Replying to Ada .*Morning, all quiet otherwise\./);
  const box = () => findAll(v.tree, (n) => n.props['data-dsh-bots-composer'])[0];
  assert.equal(box().props.placeholder, 'Message @ada');
  box().props.onChange({ target: { value: 'Tell me tomorrow too' } });
  await v.rerender(1);
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
  await v.rerender();
  assert.deepEqual(v.posts.filter((x) => x.path.endsWith('/send')).at(-1).body, { to: 'bot-a', text: 'Tell me tomorrow too', replyTo: 'general' });
  assert.equal(quoteBar().length, 0);
  // At the end of the chat, queued, quoting Ada's message.
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-msg-id'), [...CHAT_IDS, 'psent0001']);
  const [sent] = findAll(mainOf(v.tree), (n) => n.props['data-dsh-bots-msg-id'] === 'psent0001');
  assert.match(collect(sent).join(' '), /Ada: .*Morning, all quiet otherwise\. .*Tell me tomorrow too .*Queued/);
  // The next message goes to the chat itself.
  box().props.onChange({ target: { value: 'Something else' } });
  await v.rerender(1);
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
  await v.rerender();
  assert.deepEqual(v.posts.filter((x) => x.path.endsWith('/send')).at(-1).body, { to: 'bot-a', text: 'Something else' });
  assert.equal(findAll(findAll(mainOf(v.tree), (n) => n.props['data-dsh-bots-msg-id'] === 'psent0002')[0], (n) => n.props['data-dsh-bots-quoted'] !== undefined).length, 0);
  // Escape drops a quote.
  click(v.tree, 'data-dsh-bots-reply-to', 'r1');
  await v.rerender(1);
  assert.equal(quoteBar().length, 1);
  box().props.onKeyDown({ key: 'Escape', stopPropagation() {} });
  await v.rerender(1);
  assert.equal(quoteBar().length, 0);
  v.hooks.runCleanups();
});

test('threads: a link opens the thread on its own; its composer answers the root or a message picked inside, and both show in the chat too', async () => {
  const v = await threadsChat();
  click(v.tree, 'data-dsh-bots-thread-bar', 'pbeijing1');
  await v.rerender();
  const p = pane(v.tree);
  assert.ok(p, 'the thread pane');
  assert.ok(v.gets.some((g) => /messages\?limit=500&bot=bot-a&topic=pbeijing1$/.test(g)), 'it polls its thread');
  // Root, a divider with the count, the replies in order; Bob's answer in full; the thread's task; no quote of the root.
  assert.deepEqual(attrs(p, 'data-dsh-bots-msg-id'), ['pbeijing1', 'pq1haidia', 'r2']);
  assert.deepEqual(attrs(p, 'data-dsh-bots-thread-count'), [2]);
  assert.match(collect(p).join(' '), /Thread .*Look up the Beijing work residence permit .*2 replies .*Does Haidian differ\? .*three conditions/);
  assert.deepEqual(attrs(p, 'data-dsh-bots-thread-tasks'), [1]);
  assert.deepEqual(attrs(p, 'data-dsh-bots-quoted'), []);
  const composer = () => findAll(v.tree, (n) => n.props['data-dsh-bots-thread-composer'] === 'pbeijing1')[0];
  assert.equal(composer().props.placeholder, 'Reply in this thread');
  composer().props.onChange({ target: { value: 'Thanks, and Chaoyang?' } });
  await v.rerender(1);
  composer().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
  await v.rerender();
  assert.deepEqual(v.posts.filter((x) => x.path.endsWith('/send')).at(-1).body, { to: 'bot-a', text: 'Thanks, and Chaoyang?', replyTo: 'pbeijing1' });
  // Reply on Bob's answer quotes it; the message stays in this thread and answers it.
  click(pane(v.tree), 'data-dsh-bots-reply-to', 'r2');
  await v.rerender(1);
  assert.equal(pane(v.tree).props['data-dsh-bots-thread-pane'], 'pbeijing1');
  assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-thread-quote'] === 'r2')[0]).join(' '), /Replying to Bob .*Beijing permit: three conditions\./);
  composer().props.onChange({ target: { value: 'Which social insurance?' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-thread-send', 'pbeijing1');
  await v.rerender();
  assert.deepEqual(v.posts.filter((x) => x.path.endsWith('/send')).at(-1).body, { to: 'bot-a', text: 'Which social insurance?', replyTo: 'r2' });
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-thread-quote'] !== undefined).length, 0);
  // In the thread, the one that answers Bob quotes him; in the chat, both quote what they answer.
  assert.deepEqual(attrs(pane(v.tree), 'data-dsh-bots-quoted'), ['r2']);
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-msg-id'), [...CHAT_IDS, 'psent0001', 'psent0002']);
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-quoted'), ['pbeijing1', 'pbeijing1', 'r2']);
  click(v.tree, 'data-dsh-bots-thread-close', 'pbeijing1');
  await v.rerender();
  assert.equal(pane(v.tree), undefined);
  v.hooks.runCleanups();
});

test('threads: a message shows at once as queued, the Host copy replaces it; a failed one turns red and sends again', async () => {
  let fail = true;
  let release;
  const gate = new Promise((r) => (release = r));
  const v = await threadsChat({
    send: (body) => (fail ? { ok: false, reason: 'HTTP 500' } : { ok: true, sessionId: 'sess-a', message: { id: 'psent0009', from: 'user', to: 'bot-a', chat: 'bot-a', kind: 'user', text: body.text, at: Date.now(), pending: true } }),
  });
  // A Host copy of an earlier message that is still waiting for the bot reads as queued.
  v.host.items = [...mainItems(), { id: 'pqueued01', from: 'user', to: 'bot-a', chat: 'bot-a', kind: 'user', text: 'Still waiting', at: Date.now(), pending: true }];
  const box = () => findAll(v.tree, (n) => n.props['data-dsh-bots-composer'])[0];
  // The send is slow: the bubble is there before the Host answers.
  const slow = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/send')) await gate;
    return slow(url, init);
  };
  box().props.onChange({ target: { value: 'Shenzhen too' } });
  await v.rerender(1);
  box().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
  let tree = await v.rerender(1);
  const local = findAll(tree, (n) => n.props['data-dsh-bots-msg'] === 'user' && n.props['data-local'] === 'true');
  assert.equal(local.length, 1, 'shown before the Host answers');
  assert.match(collect(local[0]).join(' '), /Shenzhen too .*Queued/);
  assert.equal(box().props.value, '', 'the composer is free for the next message');
  release();
  tree = await v.rerender();
  // It failed: red, with Send again.
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-send-failed'] !== undefined).length, 1);
  assert.match(collect(findAll(tree, (n) => n.props['data-dsh-bots-send-failed'] !== undefined)[0]).join(' '), /Not sent/);
  fail = false;
  click(tree, 'data-dsh-bots-resend');
  tree = await v.rerender();
  const sends = v.posts.filter((x) => x.path.endsWith('/send'));
  assert.deepEqual(sends.map((x) => x.body), [{ to: 'bot-a', text: 'Shenzhen too' }, { to: 'bot-a', text: 'Shenzhen too' }]);
  assert.equal(findAll(tree, (n) => n.props['data-dsh-bots-send-failed'] !== undefined).length, 0);
  // The Host's copy took its place in the main chat: its id, still queued.
  assert.equal(findAll(mainOf(tree), (n) => n.props['data-dsh-bots-msg-id'] === 'psent0009').length, 1);
  assert.equal(findAll(tree, (n) => n.props['data-local'] === 'true' && n.props['data-dsh-bots-msg-id'] !== 'psent0009').length, 0);
  assert.deepEqual(attrs(tree, 'data-dsh-bots-pending').sort(), ['pqueued01', 'psent0009']);
  v.hooks.runCleanups();
});

test('threads: rows of 0.9 read as the chat they were, with no quotes and no link: the replies are right under their root', async () => {
  const items = [
    { id: 'pold00001', from: 'user', to: 'bot-a', chat: 'bot-a', text: 'Old topic root', at: T0, kind: 'user', topic: 'pold00001', thread: 'panel:sess-a:pold00001' },
    { id: 'rold1', from: 'bot-a', to: 'user', chat: 'bot-a', text: 'Old answer inside', at: T0 + 1000, kind: 'reply', topic: 'pold00001', thread: 'panel:sess-a:pold00001' },
    { id: 'pmoved001', from: 'user', to: 'bot-a', chat: 'bot-a', text: 'Moved in', at: T0 + 2000, kind: 'user', topic: 'pmoved001', movedTo: 'pold00001' },
    { id: 'after', from: 'bot-a', to: 'user', chat: 'bot-a', text: 'Later in the chat', at: T0 + 3000, kind: 'reply' },
  ];
  const v = await threadsChat({ items, replies: {}, threads: {} });
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-msg-id'), ['pold00001', 'rold1', 'pmoved001', 'after']);
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-quoted'), []);
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-thread-bar'), []);
  v.hooks.runCleanups();
  // A later reply away from its root brings the link back, and the thread holds them all.
  const late = { id: 'plate0001', from: 'user', to: 'bot-a', chat: 'bot-a', text: 'One more thing', at: T0 + 4000, kind: 'user', topic: 'pold00001', thread: 'panel:sess-a:pold00001' };
  const w = await threadsChat({ items: [...items, late], replies: {}, threads: {} });
  assert.deepEqual(attrs(mainOf(w.tree), 'data-dsh-bots-thread-bar'), ['pold00001']);
  assert.equal(collect(findAll(w.tree, (n) => n.props['data-dsh-bots-thread-bar'] === 'pold00001')[0]).join(' '), '3 replies');
  click(w.tree, 'data-dsh-bots-thread-bar', 'pold00001');
  await w.rerender();
  assert.deepEqual(attrs(pane(w.tree), 'data-dsh-bots-msg-id'), ['pold00001', 'rold1', 'pmoved001', 'plate0001']);
  assert.deepEqual(attrs(pane(w.tree), 'data-dsh-bots-moved-in'), ['pmoved001']);
  w.hooks.runCleanups();
});

test('threads: a teammate answering in a thread shows its own face and its task; a finished answer is just the answer, no status', async () => {
  const v = await threadsChat();
  click(v.tree, 'data-dsh-bots-thread-bar', 'pbeijing1');
  await v.rerender();
  const p = pane(v.tree);
  const [answer] = findAll(p, (n) => n.props['data-dsh-bots-msg-id'] === 'r2');
  assert.equal(answer.props['data-dsh-bots-worker'], 'bot-b');
  assert.match(collect(answer).join(' '), /Bob .*@bob /);
  assert.equal(findAll(answer, (n) => n.props['data-dsh-bots-report'] === 'done').length, 0);
  assert.equal(findAll(answer, (n) => n.props['data-dsh-bots-worker-task'] === 'tdone0001').length, 1);
  assert.equal(findAll(answer, (n) => n.props['data-dsh-bots-task-card'] === 'tdone0001').length, 1);
  // Your own reply in the thread is no worker's.
  assert.equal(findAll(p, (n) => n.props['data-dsh-bots-msg-id'] === 'pq1haidia')[0].props['data-dsh-bots-worker'], undefined);
  v.hooks.runCleanups();
});

test('chat: work a bot hands itself is not shown as a message to itself; while it works the chat shows the bot at work, what it does now', async () => {
  const state = { bots: BOTS.map((b) => (b.id === 'bot-a' ? { ...b, status: 'idle' } : b)), taskActivity: { tself0001: { ...SEARCHING, botId: 'bot-a', title: 'Beijing weather' } } };
  const items = [
    { id: 'pweather1', from: 'user', to: 'bot-a', chat: 'bot-a', text: 'Study the Beijing weather', at: T0, kind: 'user', thread: 'panel:sess-a' },
    { id: 'dself1', from: 'bot-a', to: 'bot-a', text: 'Task: look up the weather in Beijing for the coming weeks…', at: T0 + 5000, kind: 'dm', ticket: 'tself0001' },
    { id: 'ack1', from: 'bot-a', to: 'user', chat: 'bot-a', text: 'Let me look into it, back in a few minutes.', at: T0 + 6000, kind: 'reply', thread: 'panel:sess-a' },
    { id: 'dbob1', from: 'bot-a', to: 'bot-b', text: 'Check the air quality too', at: T0 + 7000, kind: 'dm', ticket: 'tbob0001' },
  ];
  const v = await threadsChat({ items, replies: {}, threads: {}, state });
  const main = mainOf(v.tree);
  assert.deepEqual(attrs(main, 'data-dsh-bots-msg-id'), ['pweather1', 'ack1']);
  // Handing work to a teammate still shows, as a line between bots.
  assert.match(collect(main).join(' '), /Ada .*Bob/);
  assert.doesNotMatch(collect(main).join(' '), /look up the weather in Beijing/);
  const [working] = findAll(main, (n) => n.props['data-dsh-bots-working'] === 'bot-a');
  assert.ok(working, 'Ada at work');
  assert.match(collect(working).join(' '), /Shanghai hukou 2026/);
  v.hooks.runCleanups();
});

test('threads: a thread answering shows the bot at work at the end of the chat; opening one with new replies tells the Host they were read, once', async () => {
  // Ada herself is idle.
  const state = { bots: BOTS.map((b) => (b.id === 'bot-a' ? { ...b, status: 'idle' } : b)) };
  const threads = threadSummaries();
  threads.pbeijing1 = { ...threads.pbeijing1, answering: true };
  const busy = await threadsChat({ threads, state });
  assert.deepEqual(attrs(mainOf(busy.tree), 'data-dsh-bots-working'), ['bot-a']);
  busy.hooks.runCleanups();
  // A task working in a thread is no answer coming in the chat.
  const v = await threadsChat({ state });
  assert.deepEqual(attrs(mainOf(v.tree), 'data-dsh-bots-working'), []);
  click(v.tree, 'data-dsh-bots-thread-bar', 'pbeijing1');
  await v.rerender();
  await v.rerender();
  assert.deepEqual(v.posts.filter((x) => x.path.endsWith('/threads/seen')).map((x) => x.body), [{ bot: 'bot-a', root: 'pbeijing1' }]);
  click(v.tree, 'data-dsh-bots-thread-close', 'pbeijing1');
  await v.rerender();
  // A thread with nothing unread is not marked again.
  click(v.tree, 'data-dsh-bots-thread-bar', 'pbeijing1');
  await v.rerender();
  assert.equal(v.posts.filter((x) => x.path.endsWith('/threads/seen')).length, 1);
  v.hooks.runCleanups();
});

test('threads: a Host that runs another Bots than this page says to restart Harness', async () => {
  const stale = await threadsChat({ state: { botsVersion: '0.9.0' } });
  const [banner] = findAll(stale.tree, (n) => n.props['data-dsh-bots-version-stale'] !== undefined);
  assert.equal(banner?.props['data-dsh-bots-version-stale'], '0.9.0');
  assert.match(collect(banner).join(' '), /Harness still runs Bots 0\.9\.0; this page is 0\.20\.2\. Quit and reopen Harness/);
  stale.hooks.runCleanups();
  for (const state of [{ botsVersion: '0.20.2' }, { version: 7 }, {}]) {
    const v = await threadsChat({ state });
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-version-stale'] !== undefined).length, 0, JSON.stringify(state));
    v.hooks.runCleanups();
  }
});

test('threads: Harness closing the panel over a new topic opens it again; closing it otherwise is left alone', async () => {
  /** A layout whose panelInfo is observable, like Harness's. */
  const layout = () => {
    const subs = new Set();
    const l = {
      info: { activePanelId: 'bots' },
      selected: [],
      selectPanel(id) {
        l.selected.push(id);
        l.info = { activePanelId: id };
      },
      panelInfo: {
        getSnapshot: () => l.info,
        subscribe(fn) {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      },
      close() {
        l.info = { activePanelId: null };
        for (const fn of [...subs]) fn();
      },
    };
    return l;
  };
  // A new topic from here: Harness closes the panel; it comes back, on that bot's chat.
  const a = layout();
  const v = await threadsChat({ services: { layout: a } });
  click(v.tree, 'data-dsh-bots-new-topic', 'chat');
  a.close();
  await flush();
  assert.deepEqual(a.selected, ['bots']);
  v.hooks.runCleanups();
  // Closed by the person, with no topic starting: it stays closed.
  const b = layout();
  const w = await threadsChat({ services: { layout: b }, state: { rotatedAt: 0 } });
  b.close();
  for (let i = 0; i < 4; i += 1) await flush();
  assert.deepEqual(b.selected, []);
  w.hooks.runCleanups();
  // A topic the Host started (the state says when): the panel comes back too.
  const c = layout();
  const x = await threadsChat({ services: { layout: c }, state: { rotatedAt: Date.now() } });
  c.close();
  for (let i = 0; i < 4; i += 1) await flush();
  assert.deepEqual(c.selected, ['bots']);
  x.hooks.runCleanups();
});

test('threads: every new word has English and Chinese', async () => {
  const { exports } = await loadClient();
  const { ctx, seen } = fakeContext();
  exports.apply(ctx);
  const { en, zh } = seen.locale.dict;
  const keys = ['replyAction', 'replyingTo', 'cancelReply', 'quoteWho', 'threadWord', 'threadPaneTitle', 'threadReplyOne', 'threadReplies', 'threadEmpty', 'threadComposer', 'threadRunning', 'openThread', 'closeThread', 'movedIn', 'versionStale', 'msgPending', 'msgPendingHint', 'msgFailed', 'resend'];
  for (const k of keys) {
    assert.ok(en[k] && zh[k], k);
    assert.notEqual(en[k], zh[k], k);
  }
  assert.equal(zh.threadPaneTitle, '讨论串');
  assert.equal(zh.quoteWho, '{name}：');
  assert.equal(zh.threadEmpty, '还没有回复。在这里回复会引用这条消息');
  assert.equal(zh.msgPending, '排队中');
  // "New topic" keeps meaning a fresh conversation; nothing about threads says 话题 any more.
  assert.equal(zh.newTopic, '新话题');
  for (const k of keys) assert.doesNotMatch(zh[k], /话题/, k);
});

test('board: a new card takes pasted images and files picked in its project\'s folder, and posts their ids and paths', async () => {
  const v = await openView('data-dsh-bots-needs-entry');
  const plain = globalThis.fetch;
  const gets = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/images') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      v.posts.push({ path, body });
      return { ok: true, json: async () => ({ ok: true, image: { id: 'att000000001', url: '/__dsh_bots/image/att000000001', width: 800, height: 600, name: body.name } }) };
    }
    if (path.startsWith('/__dsh_bots/files?')) {
      gets.push(path);
      return { ok: true, json: async () => ({ ok: true, root: '/Users/me/opc', files: ['docs/plan.md'], truncated: false }) };
    }
    return plain(url, init);
  };
  const saved = { FileReader: globalThis.FileReader, createObjectURL: URL.createObjectURL };
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,iVBORw0KGgo=`;
      setTimeout(() => this.onload?.(), 0);
    }
  };
  URL.createObjectURL = () => 'blob:preview';
  try {
    click(v.tree, 'data-dsh-bots-board-new');
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-card-title'])[0].props.onChange({ target: { value: 'Fix the login page' } });
    findAll(v.tree, (n) => n.props['data-dsh-bots-card-project'])[0].props.onChange({ target: { value: 'pjopc00001' } });
    await v.rerender(1);
    // A screenshot pasted into the description is stored at once.
    let prevented = false;
    findAll(v.tree, (n) => n.props['data-dsh-bots-card-description'])[0].props.onPaste({ clipboardData: { files: [{ name: 'login.png', type: 'image/png' }] }, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    await new Promise((r) => setTimeout(r, 5));
    await v.rerender();
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-attached-item']).map((n) => n.props['data-dsh-bots-attached-item']), ['ready']);
    // The file picker looks in the folder of the project chosen.
    click(v.tree, 'data-dsh-bots-file-button', 'card');
    await v.rerender();
    assert.deepEqual(gets, ['/__dsh_bots/files?card=1&project=pjopc00001&q=']);
    click(v.tree, 'data-dsh-bots-file-option', 'docs/plan.md');
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-card-project'])[0].props.onChange({ target: { value: '' } });
    await v.rerender(1);
    findAll(v.tree, (n) => n.props['data-dsh-bots-card-project'])[0].props.onChange({ target: { value: 'pjopc00001' } });
    await v.rerender(1);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-file-ref']).map((n) => n.props['data-dsh-bots-file-ref']), ['/Users/me/opc/docs/plan.md']);
    click(v.tree, 'data-dsh-bots-card-later');
    await v.rerender();
    // By its full path: the card's folder changes with its project, and a file picked stays the same file.
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/create')).body, { title: 'Fix the login page', description: '', projectId: 'pjopc00001', assignee: '', start: false, images: ['att000000001'], files: ['/Users/me/opc/docs/plan.md'] });
    v.hooks.runCleanups();
  } finally {
    globalThis.fetch = plain;
    globalThis.FileReader = saved.FileReader;
    URL.createObjectURL = saved.createObjectURL;
  }
});

test('board: cards filter by project; a new card posts what the person filled in, now or for later; dragging starts one or marks it done', async () => {
  const v = await openView('data-dsh-bots-needs-entry');
  // Filters: every card, a project's, those under none.
  const filters = findAll(v.tree, (n) => n.props['data-dsh-bots-board-filter']).map((n) => [n.props['data-dsh-bots-board-filter'], collect(n).join(' ')]);
  assert.deepEqual(filters, [['all', 'All 5'], ['pjopc00001', 'OPC One-person company 2'], ['none', 'No project 3']]);
  click(v.tree, 'data-dsh-bots-board-filter', 'pjopc00001');
  await v.rerender(1);
  const shown = () => findAll(v.tree, (n) => n.props['data-dsh-bots-need']).map((n) => n.props['data-dsh-bots-need']);
  assert.deepEqual(shown(), ['ntodo0001', 'nworking1']);
  // A new card, filed under the project in view, to Bob directly.
  click(v.tree, 'data-dsh-bots-board-new');
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-card-title'])[0].props.onChange({ target: { value: 'Hero image for 2.4' } });
  findAll(v.tree, (n) => n.props['data-dsh-bots-card-description'])[0].props.onChange({ target: { value: 'Calm, blue.' } });
  await v.rerender(1);
  const assignee = findAll(v.tree, (n) => n.props['data-dsh-bots-card-assignee'])[0];
  assert.deepEqual(findAll(assignee, (n) => n.type === 'option').map((o) => collect(o).join('')), ['Ada (the dispatcher decides)', 'Bob (@bob)', '研究员 (@yj)']);
  assignee.props.onChange({ target: { value: 'bot-b' } });
  await v.rerender(1);
  assert.match(collect(v.tree).join(' '), /It goes straight to that bot as a task/);
  click(v.tree, 'data-dsh-bots-card-start');
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/create')).body, { title: 'Hero image for 2.4', description: 'Calm, blue.', projectId: 'pjopc00001', assignee: 'bot-b', start: true });
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-card-title']).length, 0, 'the form closed');
  // For later: no one takes it yet.
  click(v.tree, 'data-dsh-bots-board-new');
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-card-title'])[0].props.onChange({ target: { value: 'FAQ page' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-card-later');
  await v.rerender();
  assert.deepEqual(v.posts.filter((p) => p.path.endsWith('/needs/create')).at(-1).body, { title: 'FAQ page', description: '', projectId: 'pjopc00001', assignee: '', start: false });
  // Dragging a card in To do lights In progress (start) and Done, not Waiting for you.
  const card = findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'ntodo0001')[0];
  card.props.onDragStart({ dataTransfer: { setData() {} } });
  await v.rerender(1);
  const drops = Object.fromEntries(findAll(v.tree, (n) => n.props['data-dsh-bots-need-group'] && n.props['data-dsh-bots-need-group'] !== 'stopped').map((n) => [n.props['data-dsh-bots-need-group'], n.props['data-drop'] ?? '']));
  assert.deepEqual(drops, { todo: '', working: 'start', needs: '', done: 'done' });
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-group'] === 'working')[0].props.onDrop({ preventDefault() {} });
  await v.rerender();
  assert.ok(v.posts.some((p) => p.path.endsWith('/needs/ntodo0001/start')));
  // A card under way dropped on Done: asked first, since its tasks stop.
  findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'nworking1')[0].props.onDragStart({});
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-group'] === 'done')[0].props.onDrop({ preventDefault() {} });
  await v.rerender(1);
  assert.match(collect(v.tree).join(' '), /Mark “Q3 competitor pricing table” done\?/);
  confirmButton(v.tree).props.onClick();
  await v.rerender();
  assert.ok(v.posts.some((p) => p.path.endsWith('/needs/nworking1/done')));
  v.hooks.runCleanups();
});

test('board: projects are added, changed and removed from the board', async () => {
  const v = await openView('data-dsh-bots-needs-entry');
  click(v.tree, 'data-dsh-bots-board-projects');
  await v.rerender(1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-project'] === 'pjopc00001').length, 1);
  assert.match(collect(v.tree).join(' '), /One-person company \/Users\/me\/opc/);
  click(v.tree, 'data-dsh-bots-project-new');
  await v.rerender(1);
  const field = (attr) => findAll(v.tree, (n) => n.props[attr])[0];
  // No folder dialog in this Host: the folder is typed.
  assert.equal(field('data-dsh-bots-project-pick'), undefined);
  field('data-dsh-bots-project-name').props.onChange({ target: { value: 'Website' } });
  await v.rerender(1);
  // With the desktop's folder dialog, the folder is picked; typing still works after.
  globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => '/Users/me/code/site' };
  try {
    await v.rerender(1);
    field('data-dsh-bots-project-pick').props.onClick();
    await v.rerender(1);
    assert.equal(field('data-dsh-bots-project-dir').props.value, '/Users/me/code/site');
    assert.equal(field('data-dsh-bots-project-name').props.value, 'Website');
  } finally {
    delete globalThis.__DSH_DIRECTORY_PICKER__;
  }
  field('data-dsh-bots-project-dir').props.onChange({ target: { value: '~/code/site' } });
  await v.rerender(1);
  field('data-dsh-bots-project-brief').props.onChange({ target: { value: 'Astro, deployed on push.' } });
  await v.rerender(1);
  field('data-dsh-bots-project-repo').props.onChange({ target: { value: 'acme/site' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-project-save');
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/projects/save')).body, { project: { name: 'Website', key: '', dir: '~/code/site', repo: 'acme/site', brief: 'Astro, deployed on push.' } });
  // Changed: the id goes along.
  click(v.tree, 'data-dsh-bots-project-edit', 'pjopc00001');
  await v.rerender(1);
  assert.equal(field('data-dsh-bots-project-key').props.value, 'OPC');
  click(v.tree, 'data-dsh-bots-project-save');
  await v.rerender();
  assert.equal(v.posts.filter((p) => p.path.endsWith('/projects/save')).at(-1).body.project.id, 'pjopc00001');
  // Removed, after asking.
  click(v.tree, 'data-dsh-bots-project-remove', 'pjopc00001');
  await v.rerender(1);
  assert.match(collect(v.tree).join(' '), /Remove “One-person company”\?/);
  confirmButton(v.tree).props.onClick();
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/projects/delete')).body, { id: 'pjopc00001' });
  v.hooks.runCleanups();
});

test('board: a card in To do shows its reference and description, starts with whoever is chosen, moves between projects and is marked done', async () => {
  const v = await openView('data-dsh-bots-needs-entry');
  click(v.tree, 'data-dsh-bots-need', 'ntodo0001');
  await v.rerender();
  const detail = () => findAll(v.tree, (n) => n.props['data-dsh-bots-need-detail'] === 'ntodo0001')[0];
  const text = collect(detail()).join(' ');
  assert.match(text, /OPC-2 Pricing page To do/);
  assert.match(text, /Description .*Three tiers, yearly toggle\./);
  assert.doesNotMatch(text, /What you said/, 'the card itself is not repeated as the person\'s words');
  assert.match(text, /Board/);
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-assignee'] === 'ntodo0001')[0].props.onChange({ target: { value: 'bot-c' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-need-start', 'ntodo0001');
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/ntodo0001/start')).body, { assignee: 'bot-c' });
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-project'] === 'ntodo0001')[0].props.onChange({ target: { value: '' } });
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/ntodo0001/save')).body, { projectId: '' });
  click(v.tree, 'data-dsh-bots-need-describe', 'ntodo0001');
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-description-input'])[0].props.onChange({ target: { value: 'Two tiers.' } });
  await v.rerender(1);
  click(v.tree, 'data-dsh-bots-need-description-save');
  await v.rerender();
  assert.deepEqual(v.posts.filter((p) => p.path.endsWith('/needs/ntodo0001/save')).at(-1).body, { description: 'Two tiers.' });
  // Nothing under way: marked done at once.
  click(v.tree, 'data-dsh-bots-need-done', 'ntodo0001');
  await v.rerender();
  assert.ok(v.posts.some((p) => p.path.endsWith('/needs/ntodo0001/done')));
  v.hooks.runCleanups();
});

test('board: a card in To do shows what it was filed with, and one of them can be taken off before it starts', async () => {
  const kept = NEED_DETAIL.ntodo0001;
  NEED_DETAIL.ntodo0001 = { ...kept, images: [{ id: 'att000000001', url: '/__dsh_bots/image/att000000001', width: 800, height: 600, name: 'login.png' }], files: [{ path: '/Users/me/opc/docs/plan.md', name: 'docs/plan.md' }, { path: '/Users/me/opc/notes.txt', name: 'notes.txt' }] };
  try {
    const v = await openView('data-dsh-bots-needs-entry');
    click(v.tree, 'data-dsh-bots-need', 'ntodo0001');
    await v.rerender();
    assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-attachments'])[0].props['data-dsh-bots-need-attachments'], 3);
    assert.deepEqual(findAll(v.tree, (n) => n.props['data-dsh-bots-need-file']).map((n) => n.props['data-dsh-bots-need-file']), ['/Users/me/opc/docs/plan.md', '/Users/me/opc/notes.txt']);
    click(v.tree, 'data-dsh-bots-need-file-remove', '/Users/me/opc/notes.txt');
    await v.rerender();
    assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/ntodo0001/save')).body, { files: ['/Users/me/opc/docs/plan.md'] });
    click(v.tree, 'data-dsh-bots-need-image-remove', 'att000000001');
    await v.rerender();
    assert.deepEqual(v.posts.filter((p) => p.path.endsWith('/needs/ntodo0001/save')).at(-1).body, { images: [] });
    v.hooks.runCleanups();
  } finally {
    NEED_DETAIL.ntodo0001 = kept;
  }
});

test('board: a card started from the board shows in the chat with its reference, which opens the card', async () => {
  const card = { id: 'pcard0001', from: 'user', to: 'bot-b', chat: 'bot-a', kind: 'user', text: 'Pricing page\n\nThree tiers.', at: T0 + 10 * MIN, thread: 'panel:sess-a', ticket: 'tworking1', need: 'ntodo0001', card: { id: 'ntodo0001', title: 'Pricing page', ref: 'OPC-2' } };
  const v = await threadsChat({ items: [...mainItems(), card] });
  const [msg] = findAll(mainOf(v.tree), (n) => n.props['data-dsh-bots-msg-id'] === 'pcard0001');
  assert.match(collect(msg).join(' '), /^Card OPC-2 to Bob · .* Open task /);
  click(msg, 'data-dsh-bots-msg-card', 'ntodo0001');
  await v.rerender();
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-need-detail'] === 'ntodo0001').length, 1);
  v.hooks.runCleanups();
});

test('waiting cards: one whose wait is over but that did not start says why, on the board and on its page', async () => {
  const i = NEEDS.findIndex((r) => r.id === 'ntodo0001');
  const row = NEEDS[i];
  const reason = 'a file of this card was moved or deleted (notes.txt): put it back, or remove it from the card';
  NEEDS[i] = { ...row, after: [{ ...row.after[0], status: 'done' }], afterError: reason };
  try {
    const v = await openView('data-dsh-bots-needs-entry');
    const line = findAll(findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'ntodo0001')[0], (n) => n.props['data-dsh-bots-need-after'] === 'OPC-1')[0];
    assert.equal(line.props['data-error'], true);
    assert.equal(collect(line).join(''), `Did not start: ${reason}`);
    click(v.tree, 'data-dsh-bots-need', 'ntodo0001');
    await v.rerender();
    assert.ok(collect(v.tree).join(' ').includes(`They are done, but it did not start: ${reason}. Once that is fixed it starts by itself`));
    v.hooks.runCleanups();
  } finally {
    NEEDS[i] = row;
  }
});

test('waiting cards: a card in To do says what it waits for; its page adds and removes cards and names who takes it; a new card can start after one', async () => {
  const v = await openView('data-dsh-bots-needs-entry');
  const todo = findAll(v.tree, (n) => n.props['data-dsh-bots-need'] === 'ntodo0001')[0];
  assert.equal(findAll(todo, (n) => n.props['data-dsh-bots-need-after'] === 'OPC-1').length, 1);
  assert.match(collect(todo).join(' '), /After OPC-1/);
  // A new card that starts after another: one button, saying when.
  click(v.tree, 'data-dsh-bots-board-new');
  await v.rerender(1);
  findAll(v.tree, (n) => n.props['data-dsh-bots-card-title'])[0].props.onChange({ target: { value: 'Launch post' } });
  await v.rerender(1);
  const select = findAll(v.tree, (n) => n.props['data-dsh-bots-card-after'])[0];
  assert.deepEqual(findAll(select, (n) => n.type === 'option').map((o) => o.props.value), ['', 'nwaiting1', 'nworking1', 'ntodo0001'], 'done and dropped cards are not waited for');
  select.props.onChange({ target: { value: 'nworking1' } });
  await v.rerender(1);
  assert.equal(findAll(v.tree, (n) => n.props['data-dsh-bots-card-later']).length, 0);
  assert.equal(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-card-start'])[0]).join(''), 'Start after OPC-1');
  click(v.tree, 'data-dsh-bots-card-start');
  await v.rerender();
  assert.deepEqual(v.posts.find((p) => p.path.endsWith('/needs/create')).body, { title: 'Launch post', description: '', projectId: '', assignee: '', start: true, after: ['nworking1'] });
  // Its page: remove what it waits for, add another, and say who takes it then.
  click(v.tree, 'data-dsh-bots-need', 'ntodo0001');
  await v.rerender();
  assert.match(collect(findAll(v.tree, (n) => n.props['data-dsh-bots-need-after-edit'] === 'ntodo0001')[0]).join(' '), /OPC-1 Q3 competitor pricing table In progress/);
  click(v.tree, 'data-dsh-bots-need-after-remove', 'nworking1');
  await v.rerender();
  assert.deepEqual(v.posts.filter((p) => p.path.endsWith('/needs/ntodo0001/save')).at(-1).body, { after: [] });
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-after-add'] === 'ntodo0001')[0].props.onChange({ target: { value: 'nwaiting1' } });
  await v.rerender();
  assert.deepEqual(v.posts.filter((p) => p.path.endsWith('/needs/ntodo0001/save')).at(-1).body, { after: ['nworking1', 'nwaiting1'] });
  findAll(v.tree, (n) => n.props['data-dsh-bots-need-after-who'] === 'ntodo0001')[0].props.onChange({ target: { value: 'bot-b' } });
  await v.rerender();
  assert.deepEqual(v.posts.filter((p) => p.path.endsWith('/needs/ntodo0001/save')).at(-1).body, { after: ['nworking1'], startWith: 'bot-b' });
  v.hooks.runCleanups();
});

test('channels: GitHub Issues pairs nobody: it shows the repositories it watches, the label, and who may start work', async () => {
  const GH_ENTRY = { ...TG_ENTRY, id: 'github-issues', channel: 'github', name: { en: 'GitHub Issues', zh: 'GitHub Issues' }, fields: [] };
  await withFixtures(() => {
    CATALOG.templates.push(GH_ENTRY);
    BOTS[0].apps = [{ id: 'gh1', template: 'github-issues', name: 'GitHub Issues', serverName: 'github-issues', enabled: true, values: { token: '••••••••', repos: 'acme/site' }, config: {} }];
    BOTS[0].channels = { gh1: { kind: 'github', state: 'connected', account: { username: 'acme-bots', name: '' }, paired: [], code: null, link: null, invite: null, scheduleReplies: true, ignored: { count: 3, lastName: 'drive-by' }, vouched: true, watching: { repos: ['acme/site'], label: 'bots' } } };
  }, async () => {
    const v = await openTab('apps', 'bot-a');
    const [panel] = findAll(v.tree, (n) => n.props['data-dsh-bots-channel'] === 'gh1');
    const text = collect(panel).join(' ');
    assert.match(text, /Connected as @acme-bots/);
    assert.match(text, /Watching .*acme\/site/);
    assert.match(text, /gets the label bots becomes a card on the board/);
    assert.match(text, /Ignored 3 issues or comments from people who are not the repository's owner, members or collaborators \(last: drive-by\)/);
    assert.match(text, /Only the repository's owner, members and collaborators start work/);
    assert.doesNotMatch(text, /Paired people|Pair yourself|Nobody yet/);
    assert.equal(findAll(panel, (n) => n.props['data-dsh-bots-github-repo'] === 'acme/site')[0].props.href, 'https://github.com/acme/site/issues?q=is%3Aissue+is%3Aopen+label%3Abots');
    v.hooks.runCleanups();
  });
});
