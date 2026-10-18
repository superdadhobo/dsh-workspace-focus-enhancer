import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startNativeHost, request } from './native-host.js';

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
