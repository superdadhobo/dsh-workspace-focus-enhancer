import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-focus-unit-'));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const plugin = await import(new URL((process.env.FOCUS_REGRESSION_SOURCE || '../index.js') + '?fixture=' + randomUUID(), import.meta.url).href);
  if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old;
  const routes = new Map(), disposers = [], events = new Map(), agents = new Map();
  const workspaces = [
    { id: 'idle', path: '/fixture/idle', sessionIds: ['si'] },
    { id: 'parent', path: '/fixture/parent', sessionIds: ['sp'] },
    { id: 'child', path: '/fixture/parent/child', sessionIds: ['sc'] }
  ];
  let denial, failAuth = false, lastRequest;
  const ctx = {
    connection: { requestRejection(req) { lastRequest = req; if (failAuth) throw Error('auth not ready'); return denial; } },
    agents: { get: id => agents.get(id) },
    workspaceRegistry: {
      list: () => [...workspaces], get: id => workspaces.find(w => w.id === id),
      async insertBefore(id, before) {
        const at = workspaces.findIndex(w => w.id === id); const [row] = workspaces.splice(at, 1);
        const pos = workspaces.findIndex(w => w.id === before);workspaces.splice(pos < 0 ? workspaces.length : pos, 0, row);
      }
    },
    webServer: { register(route) { assert(!routes.has(route.path)); routes.set(route.path, route); return () => routes.delete(route.path); } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    inject() {},
    on(name, fn) { const list = events.get(name) ?? [];list.push(fn);events.set(name, list); }
  };
  async function call(path = 'status', { method = 'GET', body, raw, headers = {}, remote = '127.0.0.1' } = {}) {
    const req = new PassThrough();
    Object.assign(req, { method, url: '/api/workspace-order/' + path, headers: { host: 'dsh.housebox.top', origin: 'https://dsh.housebox.top', 'content-type': 'application/json', ...headers } });
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remote } });
    const res = { status: 0, body: null, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text);this.writableEnded = true; } };
    const running = routes.get(req.url).handler(req, res);
    req.end(raw ?? (body === undefined ? '' : JSON.stringify(body)));
    await running;return res;
  }
  const h = { root, ctx, plugin, call, routes, agents, workspaces,
    deny: code => { denial = code; }, breakAuth: () => { failAuth = true; }, lastRequest: () => lastRequest,
    emit(name, ...args) { for (const fn of events.get(name) ?? []) fn(...args); },
    async restart() { for (const d of disposers.splice(0).reverse()) await d();plugin.apply(ctx);await call(); }
  };
  t.after(async () => { for (const d of disposers.reverse()) await d(); await rm(root, { recursive: true, force: true }); });
  plugin.apply(ctx);await call();return h;
}

test('all routes use the native decision, accept a trusted remote peer and preserve the complete request', async t => {
  const h = await harness(t);
  assert.equal(h.routes.size, 5);
  const ok = await h.call('status', { remote: '192.168.50.88' });
  assert.equal(ok.status, 200);assert.equal(ok.body.protocolVersion, 2);
  assert(h.plugin.inject.includes('connection'));
  assert.equal(h.lastRequest().socket.remoteAddress, '192.168.50.88');
  assert.equal(h.lastRequest().url, '/api/workspace-order/status');
  for (const code of [401, 403]) {
    h.deny(code);
    for (const [path, method, body] of [['status','GET'],['settings','GET'],['settings','POST',{settings:{autoFront:false}}],['toggle-pin','POST',{workspaceId:'idle'}],['toggle-favorite','POST',{sessionId:'si'}],['clear-error','POST',{sessionId:'si'}]]) {
      assert.equal((await h.call(path,{method,body})).status, code, path);
    }
  }
  h.deny(undefined);
  const state = (await h.call()).body;
  assert.deepEqual(state.pinned, []);assert.deepEqual(state.favorites, []);assert.equal(state.settings.autoFront,true);
});

test('native authentication errors fail closed and do not leak error details', async t => {
  const h = await harness(t);h.breakAuth();
  const r = await h.call();assert.equal(r.status,500);assert(!JSON.stringify(r.body).includes('auth not ready'));
});

test('settings, explicit pin and favorite writes persist, survive reload and remain idempotent', async t => {
  const h = await harness(t);
  const settings = { autoFront:false,pinTop:true,badgeWaiting:false,badgeError:true,badgeRunningDone:false,autoCollapse:false,highlightCurrent:true };
  assert.equal((await h.call('settings',{method:'POST',body:{settings}})).status,200);
  for(let i=0;i<2;i++) {
    assert.equal((await h.call('toggle-pin',{method:'POST',body:{workspaceId:'child',pinned:true}})).status,200);
    assert.equal((await h.call('toggle-favorite',{method:'POST',body:{sessionId:'sc',favorite:true}})).status,200);
  }
  await h.restart();
  const state=(await h.call()).body;
  assert.deepEqual(state.settings,settings);assert.deepEqual(state.pinned,['child']);assert.deepEqual(state.favorites,['sc']);
  assert.deepEqual(h.workspaces.map(w=>w.id),['parent','child','idle']);
  assert.deepEqual(h.workspaces.find(w=>w.id==='child').sessionIds,['sc']);
  for(const file of ['workspace-pins.json','workspace-order-settings.json','workspace-favorites.json']) assert.equal((await stat(join(h.root,'storages',file))).mode&0o777,0o600);
  await h.call('toggle-pin',{method:'POST',body:{workspaceId:'child',pinned:false}});
  await h.call('toggle-favorite',{method:'POST',body:{sessionId:'sc',favorite:false}});
  assert.deepEqual((await h.call()).body.pinned,[]);assert.deepEqual((await h.call()).body.favorites,[]);
});

test('wrong methods, invalid JSON, content type, unknown keys and missing workspace never mutate settings', async t => {
  const h=await harness(t);const before=(await h.call()).body;
  assert.equal((await h.call('status',{method:'POST'})).status,405);
  for(const path of ['toggle-pin','toggle-favorite','clear-error']) assert.equal((await h.call(path)).status,405);
  assert.equal((await h.call('settings',{method:'DELETE'})).status,405);
  for(const [raw,code,headers] of [['{',400,{}],['[]',400,{}],['{"settings":{"unknown":true}}',400,{}],['{"settings":{"autoFront":"no"}}',400,{}],['{}',415,{'content-type':'text/plain'}],['x'.repeat(65537),413,{}]]) assert.equal((await h.call('settings',{method:'POST',raw,headers})).status,code);
  assert.equal((await h.call('toggle-pin',{method:'POST',body:{workspaceId:'missing'}})).status,404);
  assert.equal((await h.call('toggle-favorite',{method:'POST',body:{sessionId:'sc',favorite:'true'}})).status,400);
  assert.deepEqual((await h.call()).body.settings,before.settings);
});

test('concurrent remote changes keep unrelated settings and both favorite writes', async t => {
  const h=await harness(t);
  const results=await Promise.all([
    h.call('settings',{method:'POST',body:{settings:{autoCollapse:false}}}),
    h.call('settings',{method:'POST',body:{settings:{highlightCurrent:false}}}),
    h.call('toggle-favorite',{method:'POST',body:{sessionId:'si',favorite:true}}),
    h.call('toggle-favorite',{method:'POST',body:{sessionId:'sc',favorite:true}})
  ]);
  assert(results.every(x=>x.status===200));const state=(await h.call()).body;
  assert.equal(state.settings.autoCollapse,false);assert.equal(state.settings.highlightCurrent,false);
  assert.deepEqual(new Set(state.favorites),new Set(['si','sc']));
});

test('running, unread, approval and error states reach the status API and clear only when seen', async t => {
  const h=await harness(t);
  h.emit('api-session/status','sc',true);
  assert.deepEqual((await h.call()).body.busy,['child']);
  h.emit('session/event',{id:'sc'},{type:'approval/asked',data:{id:'approval-1'}});
  assert.deepEqual((await h.call()).body.waitingSessions,['sc']);
  h.emit('session/event',{id:'sc'},{type:'approval/decided',data:{id:'approval-1'}});
  h.emit('api-session/status','sc',false);h.emit('api-session/error','sc');
  let state=(await h.call()).body;assert.deepEqual(state.unreadSessions,['sc']);assert.deepEqual(state.errored,['child']);
  assert.equal(state.parents.child,'parent');assert.equal(state.owners.sc,'child');
  await h.call('clear-error',{method:'POST',body:{sessionId:'sc'}});
  state=(await h.call()).body;assert.deepEqual(state.unreadSessions,[]);assert.deepEqual(state.erroredSessions,[]);
  h.emit('api-session/status','sc',true);h.emit('api-session/status','sc',false);
  assert.deepEqual((await h.call()).body.unreadSessions,[],'reply watched on screen is already read');
});
