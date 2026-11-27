import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KEEP_ASKS, NEED_ID_RE, clampNeedTitle, createNeeds, needStatus } from '../lib/needs.mjs';
import { stageOf } from '../lib/tickets.mjs';

const dirOf = () => mkdtempSync(join(tmpdir(), 'bots-needs-'));
const T0 = Date.parse('2026-11-18T09:00:00Z');
const task = (id, over = {}) => ({ id, reports: [], startedAt: T0, ...over });
const ended = (outcome, at = T0 + 60_000) => ({ ended: { at, by: 'worker', outcome } });
const report = (status, at = T0 + 1000) => ({ reports: [{ at, status, text: `${status} report` }] });

test('a need\'s status comes from its tasks: waiting for the person first, then working, then how they ended', () => {
  const need = { id: 'n12345678' };
  const s = (tasks) => needStatus(need, tasks, stageOf);
  assert.equal(s([task('t1', report('question')), task('t2')]).status, 'waiting');
  assert.deepEqual(s([task('t1', report('question')), task('t2')]).waiting, ['t1']);
  // A blocked report nobody answered: the person must unblock it.
  assert.equal(s([task('t1', report('blocked'))]).status, 'waiting');
  // Answered since: back to work.
  assert.equal(s([task('t1', { ...report('question'), lastHumanAt: T0 + 2000 })]).status, 'working');
  assert.equal(s([task('t1', { startedAt: 0 })]).status, 'working', 'queued is working to the person');
  const mixed = s([task('t1', ended('done')), task('t2', ended('failed')), task('t3')]);
  assert.deepEqual([mixed.status, mixed.done, mixed.total, mixed.failed], ['working', 1, 3, 1]);
  const settled = s([task('t1', ended('done', T0 + 5000)), task('t2', ended('failed', T0 + 9000))]);
  assert.deepEqual([settled.status, settled.endedAt], ['done', T0 + 9000], 'one result in is done; the failure is counted');
  assert.equal(s([task('t1', ended('failed')), task('t2', ended('stopped'))]).status, 'failed');
  assert.equal(s([task('t1', ended('stopped'))]).status, 'stopped');
  assert.equal(s([task('t1', { stalledAt: T0 + 5000 })]).stalled, 1);
  // Dropped by the person, whatever its tasks say.
  assert.equal(needStatus({ ...need, closed: { at: T0, by: 'user' } }, [task('t1')], stageOf).status, 'stopped');
  // Its tasks pruned: the last status it was seen with.
  const gone = needStatus({ ...need, snapshot: { status: 'done', done: 2, total: 2 } }, [], stageOf);
  assert.deepEqual([gone.status, gone.done, gone.total], ['done', 2, 2]);
  assert.equal(needStatus(need, [], stageOf).status, 'working');
});

test('needs are created, take tasks and the person\'s words, and persist', () => {
  const dir = dirOf();
  let now = T0;
  const needs = createNeeds(dir, { now: () => now });
  const n = needs.create({ title: '  A comparison of   Q3 competitor pricing ', botId: 'b-atlas', origin: { threadKey: 'panel:s1', via: 'panel', bogus: 1 }, asks: [{ id: 'p1', at: T0, text: 'Compare Q3 pricing of our competitors' }], tickets: ['t1'] });
  assert.match(n.id, NEED_ID_RE);
  assert.equal(n.title, 'A comparison of Q3 competitor pricing');
  assert.deepEqual(n.origin, { threadKey: 'panel:s1', via: 'panel' });
  assert.equal(needs.byTicket('t1').id, n.id);
  now += 1000;
  needs.addTicket(n.id, 't2', [{ id: 'p1', at: T0, text: 'Compare Q3 pricing of our competitors' }, { id: 'p2', at: now, text: 'and Europe too' }]);
  assert.deepEqual(needs.get(n.id).tickets, ['t1', 't2']);
  assert.deepEqual(needs.get(n.id).asks.map((a) => a.id), ['p1', 'p2'], 'the same message is kept once');
  assert.equal(needs.get(n.id).updatedAt, now);
  // A file the next process reads.
  const again = createNeeds(dir);
  assert.equal(again.get(n.id).title, n.title);
  assert.equal(again.byTicket('t2').id, n.id);
  assert.equal(statSync(join(dir, 'needs.json')).mode & 0o777, 0o600);
  // Titles are one line, clipped.
  assert.equal([...clampNeedTitle('x'.repeat(200))].length, 80);
  assert.throws(() => needs.create({ title: '   ' }), /title/);
});

test('rename, merge and close; merged needs point at the one that took them', () => {
  const needs = createNeeds(dirOf(), { now: () => T0 });
  const a = needs.create({ title: 'Logo ideas', tickets: ['t1'], asks: [{ id: 'm1', at: T0, text: 'logo please' }], auto: true });
  const b = needs.create({ title: 'A new logo', tickets: ['t2'], asks: [{ id: 'm2', at: T0 - 5, text: 'we need a logo' }] });
  assert.equal(needs.rename(a.id, 'Three logo ideas').auto, undefined, 'a named need is no longer automatic');
  const merged = needs.merge(a.id, b.id);
  assert.equal(merged.id, b.id);
  assert.deepEqual(merged.tickets, ['t2', 't1']);
  assert.deepEqual(merged.asks.map((x) => x.id), ['m2', 'm1'], 'in the order they were said');
  assert.equal(needs.get(a.id).id, b.id, 'the old id finds the merged need');
  assert.equal(needs.byTicket('t1').id, b.id);
  assert.deepEqual(needs.list().map((n) => n.id), [b.id]);
  needs.close(b.id, { by: 'user' });
  assert.equal(needs.get(b.id).closed.by, 'user');
  // Work handed out for it again brings it back.
  needs.addTicket(b.id, 't3');
  assert.equal(needs.get(b.id).closed, undefined);
});

test('the person\'s words are capped, the request itself kept; snapshots write only on change; prune keeps open needs', () => {
  const dir = dirOf();
  let now = T0;
  const needs = createNeeds(dir, { now: () => now });
  const n = needs.create({ title: 'Weekly report', asks: [{ id: 'first', at: T0, text: 'the request' }] });
  for (let i = 0; i < 30; i += 1) needs.addAsks(n.id, [{ id: `m${i}`, at: T0 + i, text: `more ${i}` }]);
  const asks = needs.get(n.id).asks;
  assert.equal(asks.length, KEEP_ASKS);
  assert.equal(asks[0].id, 'first');
  assert.equal(asks.at(-1).id, 'm29');
  let writes = 0;
  needs.onChange(() => (writes += 1));
  needs.snapshot(n.id, { status: 'working', done: 0, total: 1, failed: 0, stalled: 0 });
  needs.snapshot(n.id, { status: 'working', done: 0, total: 1, failed: 0, stalled: 0 });
  assert.equal(writes, 1);
  // Prune: the oldest settled go; open ones stay.
  const old = [];
  for (let i = 0; i < 3; i += 1) {
    now += 1000;
    const x = needs.create({ title: `Done ${i}` });
    needs.snapshot(x.id, { status: 'done', done: 1, total: 1, failed: 0, stalled: 0 });
    old.push(x.id);
  }
  assert.equal(needs.prune({ keepSettled: 1 }), 2);
  assert.deepEqual(needs.list().map((x) => x.id).sort(), [n.id, old[2]].sort());
});

test('an unreadable needs file is set aside, not written over', () => {
  const dir = dirOf();
  writeFileSync(join(dir, 'needs.json'), '{nope');
  const needs = createNeeds(dir);
  assert.deepEqual(needs.list(), []);
  needs.create({ title: 'Fresh' });
  assert.ok(readdirSync(dir).some((f) => f.startsWith('needs.json.corrupt-')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'needs.json'), 'utf8')).needs.length, 1);
});

// --- the board (Bots 0.12) ------------------------------------------------------------------------

test('a card filed for later is in To do until it is started; one marked done is done whatever its tasks say', () => {
  const need = { id: 'n12345678' };
  assert.equal(needStatus({ ...need, todo: true, tickets: [] }, [], stageOf).status, 'todo');
  // Started: work handed out, or the dispatcher still reading it.
  assert.equal(needStatus({ ...need, tickets: [] }, [], stageOf).status, 'working');
  assert.equal(needStatus({ ...need, closed: { at: T0, by: 'user', outcome: 'done' } }, [task('t1')], stageOf).status, 'done');
  assert.equal(needStatus({ ...need, closed: { at: T0, by: 'user' } }, [], stageOf).status, 'stopped');
});

test('cards keep a project and number, a description, and To do; starting, holding, closing and filing change them', () => {
  const dir = dirOf();
  let now = T0;
  const needs = createNeeds(dir, { now: () => now });
  const n = needs.create({ title: 'Landing page', description: '  Hero, pricing, FAQ.  ', projectId: 'pjabcdefgh', number: 3, todo: true, asks: [{ at: T0, text: 'Landing page' }] });
  assert.deepEqual([n.projectId, n.number, n.description, n.todo], ['pjabcdefgh', 3, 'Hero, pricing, FAQ.', true]);
  // A number counts only with its project, and a project only with its number.
  assert.equal(needs.create({ title: 'x', projectId: 'pjabcdefgh' }).projectId, undefined);
  assert.equal(needs.create({ title: 'y', projectId: 'bogus', number: 2 }).number, undefined);
  now += 1000;
  needs.start(n.id);
  assert.equal(needs.get(n.id).todo, undefined);
  needs.restore(n.id, { todo: true, botId: n.botId });
  assert.equal(needs.get(n.id).todo, true, 'a start that failed puts it back');
  needs.addTicket(n.id, 't1');
  assert.equal(needs.get(n.id).todo, undefined, 'a task starts it');
  needs.close(n.id, { by: 'user', outcome: 'done' });
  assert.deepEqual(needs.get(n.id).closed, { at: now, by: 'user', outcome: 'done' });
  needs.addTicket(n.id, 't2');
  assert.equal(needs.get(n.id).closed, undefined, 'more work makes it live again');
  needs.file(n.id, { projectId: 'pjzzzzzzzz', number: 1 });
  assert.deepEqual([needs.get(n.id).projectId, needs.get(n.id).number], ['pjzzzzzzzz', 1]);
  needs.describe(n.id, '');
  assert.equal(needs.get(n.id).description, undefined);
  assert.equal(needs.unfile('pjzzzzzzzz'), 1);
  assert.deepEqual([needs.get(n.id).projectId, needs.get(n.id).number], [undefined, undefined]);
  // A start that failed puts back what it changed.
  const before = { todo: undefined, closed: { at: now, by: 'user' }, snapshot: undefined, botId: 'b-old' };
  needs.start(n.id, { botId: 'b-new' });
  assert.equal(needs.get(n.id).botId, 'b-new');
  needs.restore(n.id, before);
  assert.deepEqual([needs.get(n.id).closed, needs.get(n.id).botId], [before.closed, 'b-old']);
  // Work merged into a card in To do starts it.
  const later = needs.create({ title: 'Later', todo: true });
  const other = needs.create({ title: 'Other', tickets: ['t9'] });
  assert.equal(needs.merge(other.id, later.id).todo, undefined);
  // Read back.
  needs.file(n.id, { projectId: 'pjzzzzzzzz', number: 7 });
  const again = createNeeds(dir).get(n.id);
  assert.deepEqual([again.projectId, again.number, again.tickets], ['pjzzzzzzzz', 7, ['t1', 't2']]);
});

test('an archived card is kept through a reload and by prune, and comes back when restored or worked on again', () => {
  const dir = dirOf();
  let now = T0;
  const needs = createNeeds(dir, { now: () => now });
  const settled = (title) => {
    now += 1000;
    const n = needs.create({ title, projectId: 'pjabcdefgh', number: needs.list().length + 1, tickets: [`t-${title}`] });
    needs.snapshot(n.id, { status: 'done', done: 1, total: 1, failed: 0, stalled: 0 });
    return needs.get(n.id);
  };
  const old = settled('Old');
  const waits = needs.create({ title: 'Waits for it', todo: true, after: [old.id] });
  assert.equal(old.archivedAt, undefined, 'a card is on the board until it is archived');
  now += 1000;
  const put = needs.archive(old.id);
  assert.deepEqual([put.archivedAt, put.updatedAt], [now, old.updatedAt], 'putting it away is no change of the request');
  // Read back by the next process, with its number, its task and the card that waits for it.
  const again = createNeeds(dir, { now: () => now });
  assert.deepEqual([again.get(old.id).archivedAt, again.get(old.id).number, again.byTicket('t-Old').id, again.get(waits.id).after], [now, 1, old.id, [old.id]]);
  // A file written before cards could be archived, or with a bad value: on the board.
  writeFileSync(join(dir, 'needs.json'), JSON.stringify({ version: 1, needs: [{ id: 'n00000001', title: 'Before' }, { id: 'n00000002', title: 'Odd', archivedAt: 'yes' }] }));
  assert.deepEqual(createNeeds(dir).list().map((n) => n.archivedAt), [undefined, undefined]);
  // Prune: newer settled cards push out the old ones, but not the archived one.
  const newer = [settled('A'), settled('B'), settled('C')];
  assert.equal(needs.prune({ keepSettled: 1 }), 2);
  assert.deepEqual(needs.list().map((n) => n.id).sort(), [old.id, waits.id, newer[2].id].sort());
  assert.equal(needs.prune({ keepSettled: 0 }), 1);
  assert.ok(needs.get(old.id), 'however many settled cards are kept');
  // Restored: back on the board as its newest change, so it counts among the settled ones kept.
  now += 1000;
  const back = needs.unarchive(old.id);
  assert.deepEqual([back.archivedAt, back.updatedAt], [undefined, now]);
  assert.equal(needs.prune({ keepSettled: 1 }), 0);
  // Work handed out for an archived card again brings it back: a new task, a start, tasks merged into it.
  needs.archive(old.id);
  assert.equal(needs.addTicket(old.id, 't-more').archivedAt, undefined);
  needs.close(old.id, { by: 'user' });
  needs.archive(old.id);
  const before = { ...needs.get(old.id) };
  assert.equal(needs.start(old.id).archivedAt, undefined);
  // A start that reached nobody leaves it archived, as it was.
  assert.equal(needs.restore(old.id, before).archivedAt, before.archivedAt);
  const other = needs.create({ title: 'Same thing', tickets: ['t-other'] });
  assert.equal(needs.merge(other.id, old.id).archivedAt, undefined);
});

test('a card links its GitHub issue, on github.com or a GitHub Enterprise server', () => {
  const needs = createNeeds(mkdtempSync(join(tmpdir(), 'bots-needs-')));
  const n = needs.create({
    title: 'Portal login',
    links: [
      { kind: 'github', ref: 'ghe.corp.example/team/portal#7', url: 'https://ghe.corp.example/team/portal/issues/7' },
      { kind: 'github', ref: 'acme/site#12', url: 'https://github.com/acme/site/issues/12' },
      { kind: 'github', ref: 'acme/site#13', url: 'javascript:alert(1)' },
      { kind: 'github', ref: 'not a ref' },
    ],
  });
  assert.deepEqual(n.links, [
    { kind: 'github', ref: 'ghe.corp.example/team/portal#7', url: 'https://ghe.corp.example/team/portal/issues/7' },
    { kind: 'github', ref: 'acme/site#12', url: 'https://github.com/acme/site/issues/12' },
    { kind: 'github', ref: 'acme/site#13' },
  ]);
});

test('a card keeps the images and file references it was filed with, through a reload; attach replaces them', () => {
  const dir = dirOf();
  const needs = createNeeds(dir);
  const n = needs.create({
    title: 'Fix the login page',
    images: ['img-abc123', 'img-abc123', 'bad id!', 'img-def456'],
    files: [{ path: '/work/docs/plan.md', name: 'docs/plan.md' }, { path: 'relative.md' }, { path: '/work/docs/plan.md', name: 'docs/plan.md' }, { path: '/work/notes.txt' }],
  });
  assert.deepEqual(n.images, ['img-abc123', 'img-def456']);
  assert.deepEqual(n.files, [{ path: '/work/docs/plan.md', name: 'docs/plan.md' }, { path: '/work/notes.txt', name: '/work/notes.txt' }]);
  const again = createNeeds(dir).get(n.id);
  assert.deepEqual([again.images, again.files], [n.images, n.files]);
  // A card filed without any has none.
  const plain = needs.create({ title: 'Plain' });
  assert.deepEqual([plain.images, plain.files], [undefined, undefined]);
  // Replaced field by field: the one left out stays.
  assert.deepEqual(needs.attach(n.id, { files: [{ path: '/work/notes.txt', name: 'notes.txt' }] }).files, [{ path: '/work/notes.txt', name: 'notes.txt' }]);
  assert.deepEqual(needs.get(n.id).images, ['img-abc123', 'img-def456']);
  const bare = needs.attach(n.id, { images: [], files: [] });
  assert.deepEqual([bare.images, bare.files], [undefined, undefined]);
  assert.equal(needs.attach('nmissing1', { images: [] }), undefined);
});
