import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startNativeHost, request } from './native-host.js';

async function statusUntil(h, predicate, timeout = 6000) {
  const end = Date.now() + timeout;
  let last;
  do {
    const response = await request(h.port, '/api/workspace-order/status', { cookie: h.cookie });
    last = response;
    if (response.status === 200 && predicate(response.data)) return response.data;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  assert.fail('Native status did not reach the expected state: ' + JSON.stringify(last));
}

async function control(h, body) {
  const response = await request(h.port, '/api/focus-fixture', { cookie: h.cookie, body });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

async function seen(h, viewId, sessionId) {
  const response = await request(h.port, '/api/workspace-order/clear-error', { cookie: h.cookie, body: { viewId, sessionId } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
}

test('real DSH authenticates all routes, rejects untrusted requests, and persists remote writes without control registration', {skip:!process.versions.electron,timeout:90000}, async t=>{
  const h=await startNativeHost();t.after(h.close);
  const {port,cookie}=h;
  const calls=[['status'],['settings'],['settings',{settings:{autoCollapse:false,highlightCurrent:false}}],['toggle-pin',{workspaceId:h.fixture.child,pinned:true}],['toggle-favorite',{sessionId:h.fixture.session,favorite:true}],['clear-error',{sessionId:h.fixture.session}]];
  for(const [path,body] of calls) {
    const url='/api/workspace-order/'+path;
    assert.equal((await request(port,url,{body})).status,401,path+' requires login');
    assert.equal((await request(port,url,{cookie,body,host:'evil.invalid'})).status,403,path+' rejects Host');
    assert.equal((await request(port,url,{cookie,body,origin:'https://evil.invalid'})).status,403,path+' rejects Origin');
    assert.equal((await request(port,url,{cookie,body,site:'cross-site'})).status,403,path+' rejects cross-site');
    assert.equal((await request(port,url,{cookie,body,origin:'https://dsh.focus.test'})).status,200,path+' accepts trusted remote');
  }
  const login=await request(port,'/?token='+encodeURIComponent(h.token),{host:'127.0.0.1:'+port});
  const localCookie=login.headers['set-cookie'][0].split(';')[0];
  const local=await request(port,'/api/workspace-order/status',{host:'127.0.0.1:'+port,cookie:localCookie});
  const remote=await request(port,'/api/workspace-order/status',{cookie});
  assert.equal(local.status,200);assert.deepEqual(local.data,remote.data);
  assert.deepEqual(remote.data.pinned,[h.fixture.child]);assert.deepEqual(remote.data.favorites,[h.fixture.session]);
  assert.equal(remote.data.settings.autoCollapse,false);assert.equal(remote.data.settings.highlightCurrent,false);
  assert.equal(remote.data.parents[h.fixture.child],h.fixture.parent);
  for(const file of ['workspace-pins.json','workspace-order-settings.json','workspace-favorites.json']) assert(JSON.parse(await readFile(join(h.home,'storages',file),'utf8')));
  assert.equal((await request(port,'/api/workspace-order/status',{cookie,method:'POST'})).status,405);
  assert.equal((await request(port,'/api/workspace-order/settings',{cookie,raw:'{}',type:'text/plain'})).status,415);
  const method='pluginManager/listPlugins';const plugins=await request(port,'/api/'+method,{cookie,body:{type:'client-request',rpcId:'native-fixture',method,payload:{args:{}}}});
  assert(plugins.data.result.ok);assert(plugins.data.result.value.some(x=>x.moduleName==='dsh-workspace-focus-enhancer'&&x.fiberPhase==='active'));
  t.diagnostic('Real Cordis dependency checks, native cookie/Host/Origin/site fence, all six route/method combinations, remote pin/favorite/settings persistence and local/remote consistency passed.');
});

test('real DSH observes cold continued questions without activation and preserves roots, archive metadata and separate reading views', {skip:!process.versions.electron,timeout:120000}, async t => {
  const h = await startNativeHost({extended:true});t.after(h.close);
  const f = h.fixture;
  assert.equal(f.cold.live, false, 'the pending Session is actually detached, not a mock cold flag');
  assert(f.cold.questions.active.some(q => q.state === 'continued'), 'the actual native wire projection carries the pending question');
  let state = await statusUntil(h, s => s.waitingSessions.includes(f.coldQuestion) && s.waitingSessions.includes(f.approval));
  assert.equal(state.protocolVersion, 2);
  assert.equal(state.sessionTitles[f.coldQuestion], 'Cold pending question');
  assert.equal(state.stateRead.status, 'ok');
  const stillCold = await request(h.port, '/api/focus-fixture', {cookie:h.cookie});
  assert.equal(stillCold.data.cold.live, false, 'plugin polling must not activate the cold Session');

  await control(h, {action:'state',state:'waiting',sessionId:f.session});
  await statusUntil(h, s => s.waitingSessions.includes(f.session));
  await control(h, {action:'state',state:'failed',sessionId:f.session});
  await statusUntil(h, s => s.erroredSessions.includes(f.session) && !s.waitingSessions.includes(f.session));

  await seen(h, 'native-view-a', f.session);
  await seen(h, 'native-view-b', f.parentSession);
  await control(h, {action:'state',state:'completed',sessionId:f.session});
  state = await statusUntil(h, s => !s.runningSessions.includes(f.session));
  assert(!state.unreadSessions.includes(f.session), 'a different client viewing another Session cannot undo view-a reading this one');
  await seen(h, 'native-view-a', null);
  await control(h, {action:'state',state:'completed',sessionId:f.session});
  state = await statusUntil(h, s => s.unreadSessions.includes(f.session));
  await control(h, {action:'state',state:'cancelled',sessionId:f.session});
  state = await statusUntil(h, s => !s.runningSessions.includes(f.session) && !s.unreadSessions.includes(f.session));
  assert(!state.unreadSessions.includes(f.session), 'an aborted reply-free turn must not invent a new reply');

  await seen(h, 'native-view-b', null);
  const childId = 'session-focus-native-subagent';
  await control(h, {action:'subagent',sessionId:childId,parentSession:f.parentSession,running:true});
  await statusUntil(h, s => s.runningSessions.includes(f.parentSession));
  await control(h, {action:'subagent',sessionId:childId,failed:true,running:false,detach:true});
  state = await statusUntil(h, s => s.erroredSessions.includes(f.parentSession));
  assert(state.errored.includes(f.parent), 'detaching the child must not discard its root workspace failure');

  await control(h, {action:'archive',sessionId:f.session});
  state = await statusUntil(h, s => s.archivedSessions.includes(f.session));
  assert.equal(state.sessionTitles[f.session], 'Focus QA Session');
  await control(h, {action:'unarchive',sessionId:f.session});
  await statusUntil(h, s => !s.archivedSessions.includes(f.session));
  assert(!h.getOutput().includes('sessionProjections.stateOf(session, "userQuestions") is deprecated'), 'plugin uses the new observation seam, not a deprecated registry read');
  t.diagnostic('Actual JSONL persistence + detached continued projection, pre-activation approval, non-activation, two reading views, abort/no-reply, child-root error after detach and archive metadata passed.');
});
