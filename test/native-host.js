// Starts the actual installed DSH with a private temporary home and synthetic data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
const exec = promisify(execFile);
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const redact = s => String(s).replace(/token=[^\s&]+/g, 'token=[redacted]');

export function request(port, path, { host = 'dsh.focus.test', cookie, body, raw, method = body === undefined && raw === undefined ? 'GET' : 'POST', origin, site, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const q=http.request({host:'127.0.0.1',port,path,method,headers:{Host:host,...cookie?{Cookie:cookie}:{},...origin?{Origin:origin}:{},...site?{'Sec-Fetch-Site':site}:{},...method==='POST'?{'content-type':type}:{}}},r=>{
      const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:r.statusCode,headers:r.headers,data,text});});
    });
    q.on('error',reject);q.setTimeout(10000,()=>q.destroy(Error('isolated request timed out')));
    q.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
export async function startNativeHost() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-focus-native-')));
  const home=join(root,'home'),profile=join(home,'profiles/focus-test');await mkdir(profile,{recursive:true,mode:0o700});
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^DSH_|TOKEN|PASSWORD|SECRET|KEY/i.test(k)));
  Object.assign(env,{DSH_HOME:home,CI:'true'});
  let host,output='',exited=false;
  async function close() {
    if(host&&!exited) { host.kill('SIGTERM');await new Promise(resolve=>{host.once('exit',resolve);setTimeout(()=>{host.kill('SIGKILL');resolve();},5000).unref();}); }
    await rm(root,{recursive:true,force:true});
  }
  try {
    await writeFile(join(profile,'package.json'),JSON.stringify({name:'focus-test',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
    await writeFile(join(profile,'cordis.yml'),'[]\n');
    await writeFile(join(profile,'pnpm-workspace.yaml'),`packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${root}/store\n`);
    const fixture=join(root,'fixture.mjs');
    await writeFile(fixture,`export const name='focus-fixture';export const inject=['webServer','connection','workspaceRegistry','sessions'];export async function apply(ctx){
      const a=await ctx.workspaceRegistry.create(${JSON.stringify(root)},'Focus QA Parent');
      const b=await ctx.workspaceRegistry.create(${JSON.stringify(profile)},'Focus QA Child');
      const id='session-focus-qa';const session=ctx.sessions.get(id)||ctx.sessions.create(id,{meta:{cwd:${JSON.stringify(profile)}}});session.append('turn/start',{turn:1});session.append('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic sidebar fixture; no agent is started.'}]},{surfaceOp:'append'});session.append('turn/end',{turn:1,reason:{kind:'completed'}});session.append('session/title',{title:'Focus QA Session',messageSeqs:[],source:{kind:'user'}});await b.attachSession(id);
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/focus-fixture',handler(req,res){const denial=ctx.connection.requestRejection(req);if(denial){res.writeHead(denial);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({parent:a.id,child:b.id,session:id}));}}));
    }`);
    await writeFile(join(profile,'cordis.patch.yml'),`- id: connection\n  config:\n    trustedHosts: !!js "['dsh.focus.test', ...ctx.webStartup.trustedHosts]"\n- insert:\n    - id: focus-fixture\n      name: ${pathToFileURL(fixture).href}\n`);
    await exec(cli,['plugin','--profile','focus-test','add','file:'+source,'--reporter=append-only'],{env,timeout:60000,maxBuffer:128*1024});
    host=spawn(cli,['--profile','focus-test','--host','127.0.0.1','--port','0','--no-open'],{env,stdio:['ignore','pipe','pipe']});
    host.stdout.on('data',c=>{output=(output+c).slice(-100000);});host.stderr.on('data',c=>{output=(output+c).slice(-100000);});host.on('exit',()=>{exited=true;});
    let port,token,cookie,fixtureData;
    const end=Date.now()+35000;
    while(Date.now()<end) {
      if(exited)throw Error('isolated Host exited: '+redact(output).slice(-2000));
      const link=/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(output)?.[0];
      if(link) {
        const url=new URL(link);port=Number(url.port);token=url.searchParams.get('token');
        try {
          const login=await request(port,'/?token='+encodeURIComponent(token));cookie=login.headers['set-cookie']?.[0].split(';')[0];
          const r=await request(port,'/api/focus-fixture',{cookie});
          const status=await request(port,'/api/workspace-order/status',{cookie});
          if(r.status===200&&status.status===200){fixtureData=r.data;break;}
        }catch{}
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(fixtureData,'isolated plugin not ready: '+redact(output).slice(-3000));
    return {root,home,profile,port,token,cookie,fixture:fixtureData,close};
  } catch(error) { await close();throw error; }
}
