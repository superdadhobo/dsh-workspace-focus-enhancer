import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

async function harness(t, { initialize, awaitStartup = true } = {}) {
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
  const sessions = [];
  const query = { calls: [], released: 0, listError: false, failed: new Set(), noProjection: new Set(), beforeObserve: null, beforeList: null };
  function sourceOf(id) {
    return sessions.find(s => s.id === id) || { id, header: agents.get(id)?.session?.header || { id }, events: [] };
  }
  let denial, failAuth = false, lastRequest;
  const ctx = {
    connection: { requestRejection(req) { lastRequest = req; if (failAuth) throw Error('auth not ready'); return denial; } },
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    sessionQuery: {
      async listSessions(signal) {
        await query.beforeList?.(signal);
        signal.throwIfAborted();
        if (query.listError) throw Error('private persistence failure');
        const ids = new Set([...workspaces.flatMap(w => w.sessionIds), ...sessions.map(s => s.id), ...agents.keys()]);
        return [...ids].map(id => ({ header: { ...sourceOf(id).header, id }, live: agents.has(id), persisted: true }));
      },
      async observeSession(id, options) {
        query.calls.push({ id, options });
        const source = sourceOf(id);
        const events = [...(source.events || [])];
        await query.beforeObserve?.(id, options.signal);
        options.signal.throwIfAborted();
        if (query.failed.has(id)) throw Error('private log failure');
        let disposed = false;
        return { header: { ...source.header, id }, events, inheritedEventCount: source.inheritedEventCount || 0,
          projections: query.noProjection.has(id) ? undefined : { values: source.projections || { userQuestions: { active: [], settled: [] } } },
          [Symbol.dispose]() { assert(!disposed, 'lease released exactly once'); disposed = true; query.released += 1; } };
      }
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [...workspaces], get: id => workspaces.find(w => w.id === id),
      async insertBefore(id, before) {
        const at = workspaces.findIndex(w => w.id === id); const [row] = workspaces.splice(at, 1);
        const pos = workspaces.findIndex(w => w.id === before);workspaces.splice(pos < 0 ? workspaces.length : pos, 0, row);
      }
    },
    webServer: { register(route) { assert(!routes.has(route.path)); routes.set(route.path, route); return () => routes.delete(route.path); } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    inject(deps, callback) {
      assert.deepEqual(deps,['sessionQuery'],'only the real query service may be bound');
      if (ctx.sessionQuery) callback({sessionQuery:ctx.sessionQuery,effect:this.effect.bind(this)});
    },
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
  const h = { root, ctx, plugin, call, routes, agents, workspaces, sessions, query,
    deny: code => { denial = code; }, breakAuth: () => { failAuth = true; }, lastRequest: () => lastRequest,
    emit(name, ...args) {
      if (name === 'session/event') {
        const [session, event] = args;
        let source = sessions.find(s => s.id === session.id);
        if (!source) { source = { id: session.id, header: session.header || agents.get(session.id)?.session?.header || { id: session.id }, events: [] }; sessions.push(source); }
        source.events.push({ ...event, seq: source.events.length });
      }
      for (const fn of events.get(name) ?? []) fn(...args);
    },
    async dispose() { for (const d of disposers.splice(0).reverse()) await d(); },
    async restart() { await this.dispose();plugin.apply(ctx);await call(); }
  };
  t.after(async () => { await h.dispose(); assert(root.startsWith(join(tmpdir(),'dsh-focus-unit-'))); await rm(root, { recursive: true, force: true }); });
  await initialize?.(h);
  plugin.apply(ctx);if (awaitStartup) await call();return h;
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
  const settings = { autoFront:false,pinTop:true,badgeWaiting:false,badgeError:true,badgeRunningDone:false,autoCollapse:false,highlightCurrent:true,treeSessionsFirst:false };
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
  assert.deepEqual((await h.call()).body.runningSessions,['sc'],'the running session is named, not just its workspace');
  h.emit('session/event',{id:'sc'},{type:'approval/asked',data:{id:'approval-1'}});
  assert.deepEqual((await h.call()).body.waitingSessions,['sc']);
  h.emit('session/event',{id:'sc'},{type:'approval/decided',data:{id:'approval-1'}});
  // The blocking ask_user_question never reaches the durable projected fold in
  // this build; the call/result pair is what the card follows instead.
  h.emit('session/event',{id:'sc'},{type:'tool/call',data:{name:'ask_user_question',callId:'call-1',arguments:'{"questions":[]}'}});
  assert.deepEqual((await h.call()).body.waitingSessions,['sc'],'an open question parks the session');
  h.emit('session/event',{id:'sc'},{type:'tool/result',data:{message:{toolCallId:'call-1',content:[]}}});
  assert.deepEqual((await h.call()).body.waitingSessions,[],'the answer frees it again');
  h.emit('session/event',{id:'sc'},{type:'tool/call',data:{name:'ask_user_question',callId:'call-2'}});
  h.emit('session/event',{id:'sc'},{type:'turn/end',data:{reason:{kind:'aborted'}}});
  assert.deepEqual((await h.call()).body.waitingSessions,[],'a cancelled turn cannot leave the wait pinned');
  h.emit('api-session/status','sc',false);h.emit('api-session/error','sc');
  let state=(await h.call()).body;assert.deepEqual(state.unreadSessions,[],'aborted/error is not completion');assert.deepEqual(state.errored,['child']);
  h.emit('session/event',{id:'sc'},{type:'turn/start',data:{turn:1}});
  h.emit('session/event',{id:'sc'},{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Done'}]}}});
  h.emit('session/event',{id:'sc'},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
  state=(await h.call()).body;assert.deepEqual(state.unreadSessions,['sc']);
  assert.equal(state.parents.child,'parent');assert.equal(state.owners.sc,'child');
  await h.call('clear-error',{method:'POST',body:{sessionId:'sc'}});
  state=(await h.call()).body;assert.deepEqual(state.unreadSessions,[]);assert.deepEqual(state.erroredSessions,[]);
  h.emit('api-session/status','sc',true);h.emit('api-session/status','sc',false);
  assert.deepEqual((await h.call()).body.unreadSessions,[],'reply watched on screen is already read');
});

test('a question asked before this Host started is still found in the session log', async t => {
  const h=await harness(t);
  // The blocking ask_user_question is not folded by the durable projection, and
  // no event reached this process for a call logged earlier: only the log itself
  // can say the turn is parked.
  const log = (events) => ({ id: 'sc', header: { id: 'sc' }, events, snapshotEvents() { throw Error('Deprecated API used'); } });
  const call = { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } };
  h.sessions.push(log([{ type: 'turn/start', data: {} }, call]));
  assert.deepEqual((await h.call()).body.waitingSessions,['sc']);
  // A result behind it means the answer already arrived.
  h.sessions[0] = log([{ type: 'turn/start' }, call, { type: 'tool/result', data: { message: { toolCallId: 'c1' } } }]);
  assert.deepEqual((await h.call()).body.waitingSessions,[]);
  // A later turn cannot re-open an older turn's question.
  h.sessions[0] = log([call, { type: 'turn/end' }, { type: 'turn/start' }, { type: 'step/start' }]);
  assert.deepEqual((await h.call()).body.waitingSessions,[],'only the turn in flight can be parked');
});

test('a subagent still working keeps its parent workspace busy', async t => {
  const h=await harness(t);
  // The child Session is a log of its own: no workspace lists it, and the parent
  // Session's own turn already ended. Only the parent link ties the work back.
  h.agents.set('child-1',{id:'child-1',status:'running',session:{header:{id:'child-1',origin:'subagent',parentSession:'sp'}}});
  let state=(await h.call()).body;
  assert.deepEqual(state.busy,['parent'],'a running subagent counts as its parent working');
  assert.deepEqual(state.runningSessions,['sp'],'the child log is folded into the Session that spawned it');
  assert.deepEqual(state.unreadSessions,[],'no finished-unread reply is invented for the parent');
  h.agents.get('child-1').status='idle';
  state=(await h.call()).body;
  assert.deepEqual(state.busy,[],'an idle subagent leaves the workspace idle again');
  assert.deepEqual(state.runningSessions,[]);
  // The registered event still works for a top-level Session with no parent.
  h.agents.set('top',{id:'top',status:'running',session:{header:{id:'top'}}});
  h.workspaces.find(w=>w.id==='idle').sessionIds.push('top');
  assert.deepEqual((await h.call()).body.busy,['idle']);
});

function turn(h, id, { reason = 'completed', content = [{ type: 'text', text: 'A real reply' }], interrupted = false } = {}) {
  h.emit('api-session/status', id, true);
  h.emit('session/event', { id }, { type: 'turn/start', data: { turn: 1 } });
  if (content !== null) h.emit('session/event', { id }, { type: 'assistant/message', data: { turn: 1, message: { content }, ...(interrupted ? { interrupted: true } : {}) } });
  h.emit('session/event', { id }, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } });
  h.emit('api-session/status', id, false);
}
function deferred() { let resolve;const promise = new Promise(r => { resolve = r; });return { promise, resolve }; }

test('unread requires a watched completed turn and a real, non-interrupted reply', async t => {
  const h = await harness(t);
  for (const reason of ['aborted','blocked','error','max-tokens','interrupted']) {
    turn(h,'sc',{reason});
    assert.deepEqual((await h.call()).body.unreadSessions,[],reason);
  }
  for (const content of [null,[],[{type:'reasoning',text:'private'}],[{type:'text',text:'  '}],[{type:'tool-call',name:'bash',arguments:'{}'}]]) {
    turn(h,'sc',{content});assert.deepEqual((await h.call()).body.unreadSessions,[]);
  }
  turn(h,'sc',{interrupted:true});assert.deepEqual((await h.call()).body.unreadSessions,[]);
  h.emit('api-session/status','sc',true);h.emit('api-session/status','sc',false);
  assert.deepEqual((await h.call()).body.unreadSessions,[],'boolean idle is not completion');
  turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,['sc']);
  h.emit('api-session/error','sc');assert.deepEqual((await h.call()).body.unreadSessions,[],'late failure removes completion');
});

test('cold wire continued questions and pre-reload approvals restore without deprecated or activating reads', async t => {
  const h = await harness(t);
  h.sessions.push({ id:'sc', header:{id:'sc'}, events:[{type:'turn/end',data:{reason:{kind:'completed'}}}], projections:{userQuestions:{active:[{callId:'timed',state:'continued'}],settled:[]}, title:'Cold timed question'} });
  h.emit('session/event',{id:'sp'},{type:'approval/asked',data:{id:'a'}});
  h.emit('session/event',{id:'sp'},{type:'approval/asked',data:{id:'b'}});
  h.emit('session/event',{id:'sp'},{type:'approval/decided',data:{id:'a'}});
  h.emit('session/event',{id:'si'},{type:'approval/asked',data:{}});
  await h.restart();
  let r=await h.call();assert.equal(r.status,200);assert.deepEqual(new Set(r.body.waitingSessions),new Set(['sc','sp']));
  assert.equal(r.body.sessionTitles.sc,'Cold timed question');
  h.emit('session/event',{id:'sp'},{type:'approval/decided',data:{id:'b'}});
  h.sessions.find(s=>s.id==='sc').projections.userQuestions.active=[];
  assert.deepEqual((await h.call()).body.waitingSessions,[]);
  assert(h.query.calls.every(c=>c.options.projectionMode==='all'&&c.options.signal instanceof AbortSignal));
  assert.equal(h.query.released,h.query.calls.length,'every successful lease is disposed');
  assert(!h.plugin.inject.includes('sessionProjections'),'no deprecated registry-level reader');
});

test('nested subagent waits, failures and completions remain attributed after Agent detach; forks stay separate', async t => {
  const h=await harness(t);
  h.agents.set('child-a',{id:'child-a',status:'idle',session:{header:{id:'child-a',origin:'subagent',parentSession:'sp'}}});
  h.agents.set('child-b',{id:'child-b',status:'idle',session:{header:{id:'child-b',origin:'subagent',parentSession:'child-a'}}});
  h.emit('session/event',{id:'child-b'},{type:'approval/asked',data:{id:'approval'}});
  assert.deepEqual((await h.call()).body.waitingSessions,['sp']);
  h.emit('session/event',{id:'child-b'},{type:'approval/decided',data:{id:'approval'}});
  turn(h,'child-b');
  let state=(await h.call()).body;assert.deepEqual(state.unreadSessions,['sp']);assert.deepEqual(state.unread,['parent']);
  h.emit('api-session/removed','child-b');h.agents.delete('child-b');h.agents.delete('child-a');
  assert.deepEqual((await h.call()).body.unreadSessions,['sp'],'detach must retain the root mark and lineage');
  h.emit('api-session/error','child-b');assert.deepEqual((await h.call()).body.erroredSessions,['sp']);
  await h.call('clear-error',{method:'POST',body:{viewId:'root-view',sessionId:'sp'}});
  assert.deepEqual((await h.call()).body.erroredSessions,[],'opening root clears descendant failures');
  h.agents.set('fork',{id:'fork',status:'idle',session:{header:{id:'fork',origin:'fork',parentSession:'sp'}}});
  h.workspaces.find(w=>w.id==='idle').sessionIds.push('fork');turn(h,'fork');
  assert.deepEqual((await h.call()).body.unreadSessions,['fork']);
});

test('external lifecycle uses paired runIds and only valid parent catalog/header lineage', async t => {
  const h=await harness(t);
  h.sessions.push({id:'sp',header:{id:'sp'},events:[],projections:{userQuestions:{active:[]},subagentCatalog:[{id:'external',mode:'external',createdAt:1}]}});
  h.emit('subagent/start',{id:'external',runId:'run-1',provider:'remote',local:false});
  let state=(await h.call()).body;assert.deepEqual(state.runningSessions,['sp']);assert.deepEqual(state.busy,['parent']);
  h.emit('subagent/end',{id:'external',runId:'wrong',stopReason:'completed',lastAssistantMessage:[{type:'text',text:'bad'}]});
  assert.deepEqual((await h.call()).body.runningSessions,['sp']);
  h.emit('subagent/end',{id:'external',runId:'run-1',stopReason:'completed',lastAssistantMessage:[{type:'text',text:'done'}]});
  state=(await h.call()).body;assert.deepEqual(state.runningSessions,[]);assert.deepEqual(state.unreadSessions,['sp']);
  await h.call('clear-error',{method:'POST',body:{viewId:'v',sessionId:'sp'}});
  await h.call('clear-error',{method:'POST',body:{viewId:'v',sessionId:null}});
  h.emit('subagent/end',{id:'external',runId:'run-1',stopReason:'completed',lastAssistantMessage:[{type:'text',text:'done'}]});
  assert.deepEqual((await h.call()).body.unreadSessions,[],'duplicate terminal edge cannot re-add a mark');
  for (const [runId,stopReason,lastAssistantMessage] of [['run-2','aborted',[{type:'text',text:'reply'}]],['run-3','blocked',[{type:'text',text:'reply'}]],['run-4','completed',[]]]) {
    h.emit('subagent/start',{id:'external',runId,local:false});h.emit('subagent/end',{id:'external',runId,stopReason,lastAssistantMessage});
    assert.deepEqual((await h.call()).body.unreadSessions,[]);
  }
  h.emit('subagent/start',{id:'unrelated',runId:'u',local:false,parentSession:'sp',parentSessionId:'sp'});
  state=(await h.call()).body;assert.deepEqual(state.runningSessions,['unrelated']);assert.deepEqual(state.busy,[],'invented payload parent fields are ignored');
  h.emit('subagent/end',{id:'unrelated',runId:'u',stopReason:'error'});
  assert.deepEqual((await h.call()).body.erroredSessions,['unrelated']);
  h.emit('subagent/start',{id:'external',runId:'run-5',local:false});h.emit('subagent/end',{id:'external',runId:'run-5',stopReason:'error'});
  assert.deepEqual(new Set((await h.call()).body.erroredSessions),new Set(['unrelated','sp']));
});

test('archival is additive metadata and preserves favorites, owners and existing state aggregation', async t => {
  const h=await harness(t);
  h.ctx.workspaceRegistry.archivedSessionIds.push('sc');
  h.sessions.push({id:'sc',header:{id:'sc'},events:[{type:'session/title',data:{title:'Archived title'}}]});
  await h.call('toggle-favorite',{method:'POST',body:{sessionId:'sc',favorite:true}});turn(h,'sc');
  let state=(await h.call()).body;assert.deepEqual(state.archivedSessions,['sc']);assert.deepEqual(state.favorites,['sc']);assert.equal(state.owners.sc,'child');assert.equal(state.sessionTitles.sc,'Archived title');assert.deepEqual(state.unread,['child']);
  const pin=(await h.call('toggle-pin',{method:'POST',body:{workspaceId:'child',pinned:true}})).body;
  assert.deepEqual(pin.archivedSessionIds,['sc']);assert.equal(pin.sessionTitles.sc,'Archived title');
  await h.restart();state=(await h.call()).body;assert.deepEqual(state.favorites,['sc']);assert.deepEqual(h.workspaces.find(w=>w.id==='child').sessionIds,['sc']);
});

test('read failures report 503 degraded details, preserve last-good waits and recover explicitly', async t => {
  const h=await harness(t);
  h.sessions.push({id:'sc',header:{id:'sc'},events:[],projections:{userQuestions:{active:[{state:'continued'}]}}});
  assert.deepEqual((await h.call()).body.waitingSessions,['sc']);
  h.query.failed.add('sc');let r=await h.call();assert.equal(r.status,503);assert.equal(r.body.stateRead.status,'degraded');assert.deepEqual(r.body.stateRead.failedSessionIds,['sc']);assert.deepEqual(r.body.waitingSessions,['sc']);assert(!JSON.stringify(r.body).includes('private'));
  h.query.listError=true;r=await h.call();assert.equal(r.status,503);assert.equal(r.body.stateRead.catalog,'unavailable');assert.deepEqual(r.body.waitingSessions,['sc']);
  h.query.failed.clear();h.query.listError=false;h.query.noProjection.add('sc');r=await h.call();assert.equal(r.status,503);assert.deepEqual(r.body.stateRead.unavailableProjectionSessionIds,['sc']);assert.deepEqual(r.body.waitingSessions,['sc'],'missing projection keeps known timed wait');
  h.query.noProjection.clear();h.sessions.find(s=>s.id==='sc').projections.userQuestions.active=[];r=await h.call();assert.equal(r.status,200);assert.equal(r.body.stateRead.status,'ok');assert.deepEqual(r.body.waitingSessions,[]);
});

test('independent 18-second reading leases support heartbeats, hidden-null and legacy isolation', async t => {
  const h=await harness(t);let now=100000;t.mock.method(Date,'now',()=>now);
  const read=body=>h.call('clear-error',{method:'POST',body});
  await read({viewId:'a',sessionId:'sc'});await read({viewId:'b',sessionId:'sp'});turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,[]);
  await read({sessionId:null});turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,[],'legacy null cannot overwrite modern a');
  await read({viewId:'a',sessionId:null});turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,['sc'],'hidden view releases only itself');turn(h,'sp');assert.deepEqual((await h.call()).body.unreadSessions,['sc'],'b still reads sp');
  await read({viewId:'a',sessionId:'sc'});now+=17000;await read({viewId:'a',sessionId:'sc'});now+=17000;turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,[],'heartbeat renews lease');
  now+=18000;turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,['sc'],'crashed/stale client expires at 18s');
  await read({sessionId:'sc'});turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,[]);now+=18001;turn(h,'sc');assert.deepEqual((await h.call()).body.unreadSessions,['sc'],'legacy also expires');
  for (const viewId of ['',null,1,'x'.repeat(257)]) assert.equal((await read({viewId,sessionId:'sc'})).status,400);
  assert.equal((await read({viewId:'modern',workspaceId:'child'})).status,400);
});

test('overlapping polls coalesce reads and cannot resurrect waits answered during observation', async t => {
  const h=await harness(t);const gate=deferred(), entered=deferred();
  h.emit('session/event',{id:'sc'},{type:'approval/asked',data:{id:'a'}});
  h.query.beforeObserve=async id=>{if(id==='sc'){entered.resolve();await gate.promise;}};
  const before=h.query.calls.length;const a=h.call(),b=h.call();await entered.promise;
  h.emit('session/event',{id:'sc'},{type:'approval/decided',data:{id:'a'}});gate.resolve();
  const results=await Promise.all([a,b]);assert(results.every(r=>r.status===200&&r.body.waitingSessions.length===0));
  assert.equal(h.query.calls.length-before,4,'one batch plus one stale-cut retry for concurrent polls');h.query.beforeObserve=null;
  assert.deepEqual((await h.call()).body.waitingSessions,[]);
});

test('async disposer aborts and drains every in-flight observation before a replacement starts', async t => {
  const h=await harness(t);const entered=deferred(),gate=deferred();
  h.query.beforeObserve=async (id,signal)=>{if(id==='sc'){entered.resolve(signal);await gate.promise;}};
  const request=h.call();const signal=await entered.promise;
  const aborted=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  let done=false;const disposal=h.dispose().then(()=>{done=true;});
  await aborted;assert.equal(signal.aborted,true);assert.equal(done,false,'disposer must await the still-running reader');
  gate.resolve();await disposal;assert.equal((await request).status,503);
  h.query.beforeObserve=null;h.plugin.apply(h.ctx);assert.equal((await h.call()).status,200);
});

test('async disposer drains committed mutation reorders and rejects queued old writes', async t => {
  const h=await harness(t);const entered=deferred(),gate=deferred(),insert=h.ctx.workspaceRegistry.insertBefore;
  h.ctx.workspaceRegistry.insertBefore=async (...args)=>{entered.resolve();await gate.promise;return insert(...args);};
  const writing=h.call('toggle-pin',{method:'POST',body:{workspaceId:'child',pinned:true}});await entered.promise;
  const queued=h.call('toggle-favorite',{method:'POST',body:{sessionId:'sc',favorite:true}});
  let done=false;const disposal=h.dispose().then(()=>{done=true;});await Promise.resolve();await Promise.resolve();assert.equal(done,false);
  gate.resolve();await disposal;assert.equal((await writing).status,503);assert.equal((await queued).status,503);
  h.ctx.workspaceRegistry.insertBefore=insert;h.plugin.apply(h.ctx);const state=(await h.call()).body;assert.deepEqual(state.pinned,['child']);assert.deepEqual(state.favorites,[],'old queued writer must not overwrite replacement storage');
});

test('async disposer drains initial ready ordering before another instance can load', async t => {
  const entered=deferred(),gate=deferred();let insert;
  const h=await harness(t,{awaitStartup:false,initialize(h){h.agents.set('sc',{id:'sc',status:'running',session:{header:{id:'sc'}}});insert=h.ctx.workspaceRegistry.insertBefore;h.ctx.workspaceRegistry.insertBefore=async (...args)=>{entered.resolve();await gate.promise;return insert(...args);};}});
  await entered.promise;let done=false;const disposal=h.dispose().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);gate.resolve();await disposal;
  h.ctx.workspaceRegistry.insertBefore=insert;h.plugin.apply(h.ctx);assert.equal((await h.call()).status,200);
});

test('a composition without sessionQuery still exposes authenticated explicit degraded routes', async t => {
  const h=await harness(t,{initialize(h){delete h.ctx.sessionQuery;}});
  const r=await h.call();assert.equal(r.status,503);assert.equal(r.body.stateRead.status,'degraded');assert.equal(r.body.stateRead.catalog,'unavailable');assert.equal(r.body.protocolVersion,2);
  assert.equal((await h.call('settings')).status,200,'settings do not depend on Session reads');
  h.deny(401);assert.equal((await h.call()).status,401);
});

test('local lifecycle failures are attributed and local completion does not duplicate turn-log acknowledgement', async t => {
  const h=await harness(t);
  h.agents.set('local',{id:'local',status:'idle',session:{header:{id:'local',origin:'subagent',parentSession:'sp'}}});
  h.emit('subagent/start',{id:'local',runId:'local-1',local:true});turn(h,'local');
  assert.deepEqual((await h.call()).body.unreadSessions,['sp']);
  await h.call('clear-error',{method:'POST',body:{viewId:'v',sessionId:'sp'}});
  await h.call('clear-error',{method:'POST',body:{viewId:'v',sessionId:null}});
  h.emit('subagent/end',{id:'local',runId:'local-1',stopReason:'completed',lastAssistantMessage:[{type:'text',text:'done'}]});
  assert.deepEqual((await h.call()).body.unreadSessions,[]);
  h.emit('subagent/start',{id:'local',runId:'local-2',local:true});h.emit('subagent/end',{id:'local',runId:'local-2',stopReason:'error'});
  assert.deepEqual((await h.call()).body.erroredSessions,['sp']);
});

test('unrelated live events cannot erase last-good timed waits during a failed read', async t => {
  const h=await harness(t);
  h.sessions.push({id:'sc',header:{id:'sc'},events:[],projections:{userQuestions:{active:[{callId:'timed',state:'continued'}]}}});
  assert.deepEqual((await h.call()).body.waitingSessions,['sc']);
  h.emit('session/event',{id:'sc'},{type:'step/start',data:{turn:1,step:1}});h.query.failed.add('sc');
  const r=await h.call();assert.equal(r.status,503);assert.deepEqual(r.body.waitingSessions,['sc']);
});

test('conflicting parent catalogs and mismatched headers cannot guess subagent roots', async t => {
  const h=await harness(t);
  for (const id of ['sp','sc']) h.sessions.push({id,header:{id},events:[],projections:{userQuestions:{active:[]},subagentCatalog:[{id:'ambiguous',mode:'external',createdAt:1}]}});
  h.emit('subagent/start',{id:'ambiguous',runId:'a',local:false});
  h.agents.set('bad-header',{id:'bad-header',status:'running',session:{header:{id:'different-session',origin:'subagent',parentSession:'sp'}}});
  const list=h.ctx.sessionQuery.listSessions;
  h.ctx.sessionQuery.listSessions=async signal=>(await list(signal)).filter(record=>record.header.id!=='bad-header');
  const r=await h.call();assert.deepEqual(new Set(r.body.runningSessions),new Set(['ambiguous','bad-header']));assert.deepEqual(r.body.busy,[]);
});

test('a retained favorite with no logical log remains favorited without permanent read degradation', async t => {
  const h=await harness(t);h.query.failed.add('deleted-favorite');
  await h.call('toggle-favorite',{method:'POST',body:{sessionId:'deleted-favorite',favorite:true}});
  const r=await h.call();assert.equal(r.status,200);assert.deepEqual(r.body.favorites,['deleted-favorite']);assert(!h.query.calls.some(c=>c.id==='deleted-favorite'));
});

test('a full successful corpus retires gone observed wait/title sources, but detach and listing failure retain them and terminal marks survive', async t => {
  const h=await harness(t);
  h.sessions.push({id:'gone',header:{id:'gone',origin:'subagent',parentSession:'sp'},events:[],projections:{userQuestions:{active:[{callId:'timed',state:'continued'}]},title:'Gone child'}});
  h.sessions.push({id:'sp',header:{id:'sp'},events:[],projections:{userQuestions:{active:[]},subagentCatalog:[{id:'external-only',mode:'external',createdAt:1}]}});
  let r=await h.call();assert.deepEqual(r.body.waitingSessions,['sp']);assert.equal(r.body.sessionTitles.gone,'Gone child');
  h.emit('api-session/error','gone');h.emit('api-session/removed','gone');
  h.emit('subagent/start',{id:'external-only',runId:'external-run',local:false});
  h.emit('subagent/end',{id:'external-only',runId:'external-run',stopReason:'completed',lastAssistantMessage:[{type:'text',text:'External reply'}]});
  await h.call('toggle-favorite',{method:'POST',body:{sessionId:'external-only',favorite:true}});
  r=await h.call();assert.deepEqual(r.body.waitingSessions,['sp'],'Agent detach is not logical deletion');
  h.sessions.splice(h.sessions.findIndex(source=>source.id==='gone'),1);
  h.query.listError=true;r=await h.call();assert.equal(r.status,503);assert.deepEqual(r.body.waitingSessions,['sp']);assert.equal(r.body.sessionTitles.gone,'Gone child','failed listing cannot retire last-good source');
  h.query.listError=false;r=await h.call();assert.equal(r.status,200);assert.equal(r.body.stateRead.status,'ok');assert.deepEqual(r.body.waitingSessions,[]);assert(!Object.hasOwn(r.body.sessionTitles,'gone'));
  assert.deepEqual(r.body.erroredSessions,['sp'],'terminal root attention survives logical-source retirement');
  assert.deepEqual(r.body.unreadSessions,['sp'],'provider-only terminal marks are not corpus-derived cache');
  assert.deepEqual(r.body.favorites,['external-only'],'source retirement does not delete favorites');
});

test('final batch validation rereads a fast source invalidated while another worker remains in slow IO', async t => {
  const h=await harness(t), slow=deferred(), captured=deferred();
  h.emit('session/event',{id:'sp'},{type:'approval/asked',data:{id:'a'}});
  const observe=h.ctx.sessionQuery.observeSession;
  h.ctx.sessionQuery.observeSession=async (id,options)=>{
    const observation=await observe(id,options);
    if(id==='sp') {
      const release=observation[Symbol.dispose];
      observation[Symbol.dispose]=()=>{release();captured.resolve();};
    }
    return observation;
  };
  h.query.beforeObserve=async id=>{if(id==='sc') await slow.promise;};
  const request=h.call();await captured.promise;
  h.emit('session/event',{id:'sp'},{type:'approval/decided',data:{id:'a'}});
  slow.resolve();const r=await request;
  assert.equal(r.status,200);assert.deepEqual(r.body.waitingSessions,[],'a fast worker result is not final until the entire batch is validated');
  assert(h.query.calls.filter(call=>call.id==='sp').length>=3,'sp was observed at startup, initial batch and bounded final retry');
});

test('sources invalidated after every lease release exhaust bounded final rereads and return 503 degraded', async t => {
  const h=await harness(t);
  h.emit('session/event',{id:'sp'},{type:'approval/asked',data:{id:'pending'}});
  const before=h.query.calls.filter(call=>call.id==='sp').length;
  const observe=h.ctx.sessionQuery.observeSession;
  h.ctx.sessionQuery.observeSession=async (id,options)=>{
    const observation=await observe(id,options);
    if(id==='sp') {
      const release=observation[Symbol.dispose];
      observation[Symbol.dispose]=()=>{release();h.emit('session/event',{id:'sp'},{type:'step/start',data:{turn:1,step:1}});};
    }
    return observation;
  };
  const r=await h.call();assert.equal(r.status,503);assert.equal(r.body.stateRead.status,'degraded');assert(r.body.stateRead.failedSessionIds.includes('sp'));
  assert.equal(h.query.calls.filter(call=>call.id==='sp').length-before,3,'initial read plus two bounded final-batch retries');
});
