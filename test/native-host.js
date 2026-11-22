// Starts the actual installed DSH with a private temporary home and synthetic data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
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
export async function startNativeHost({ extended = false, retainOnFailure = false, bundlePath = source, reuseRoot = undefined } = {}) {
  // `reuseRoot` starts a second Host process over an existing fixture root, which
  // is how a real restart (same DSH_HOME, new process) is reproduced.
  const root = reuseRoot === undefined
    ? await realpath(await mkdtemp(join(tmpdir(),'dsh-focus-native-')))
    : await realpath(reuseRoot);
  const home=join(root,'home'),profile=join(home,'profiles/focus-test');await mkdir(profile,{recursive:true,mode:0o700});
  if (extended) { await mkdir(join(profile,'nested'),{recursive:true,mode:0o700}); await mkdir(join(root,'peer'),{recursive:true,mode:0o700}); }
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^DSH_|TOKEN|PASSWORD|SECRET|KEY/i.test(k)));
  Object.assign(env,{DSH_HOME:home,CI:'true'});
  let host,output='',exited=false,closing;
  async function stopHost() {
    if (!host || exited || host.exitCode !== null || host.signalCode !== null) return;
    await new Promise(resolve => {
      const timer=setTimeout(()=>host.kill('SIGKILL'),5000);timer.unref();
      host.once('exit',()=>{clearTimeout(timer);resolve();});host.kill('SIGTERM');
    });
  }
  function close() {
    return closing ??= (async () => {
      await stopHost();
      // Only delete the exact private directory minted above, after the Host exits.
      assert.equal(await realpath(root),root);
      assert(root.split('/').at(-1).startsWith('dsh-focus-native-'));
      await rm(root,{recursive:true,force:true});
    })();
  }
  try {
    await writeFile(join(profile,'package.json'),JSON.stringify({name:'focus-test',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
    await writeFile(join(profile,'cordis.yml'),'[]\n');
    await writeFile(join(profile,'pnpm-workspace.yaml'),`packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${root}/store\n`);
    const fixture=join(root,'fixture.mjs');
    await writeFile(fixture,await readFile(new URL('./native-fixture.js',import.meta.url)));
    await writeFile(join(profile,'cordis.patch.yml'),`- id: connection\n  config:\n    trustedHosts: !!js "['dsh.focus.test', ...ctx.webStartup.trustedHosts]"\n- id: session-persistence-jsonl\n  config: ${JSON.stringify({root:join(home,'sessions'),compression:'none'})}\n- insert:\n    - id: focus-fixture\n      name: ${pathToFileURL(fixture).href}\n      config: ${JSON.stringify({root,profile,extended})}\n`);
    const bundleTarget=resolve(bundlePath),bundleStat=await stat(bundleTarget);
    assert(bundleStat.isDirectory() || bundleStat.isFile(),'Native fixture needs a local directory or package archive');
    await exec(cli,['plugin','--profile','focus-test','add','file:'+bundleTarget,'--reporter=append-only'],{env,timeout:60000,maxBuffer:128*1024});
    host=spawn(cli,['--profile','focus-test','--host','127.0.0.1','--port','0','--no-open'],{env,stdio:['ignore','pipe','pipe']});
    host.stdout.on('data',c=>{output=(output+c).slice(-100000);});host.stderr.on('data',c=>{output=(output+c).slice(-100000);});host.on('exit',()=>{exited=true;});
    let port,token,cookie,fixtureData,lastProbe='No fixture response yet';
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
          lastProbe=redact(JSON.stringify({fixture:{status:r.status,data:r.data,text:r.text.slice(0,1000)},plugin:{status:status.status,data:status.data}}));
          if(r.status===200&&status.status===200){fixtureData=r.data;break;}
        }catch(error){lastProbe=String(error);}
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(fixtureData,'isolated plugin not ready: '+lastProbe+'\n'+redact(output).slice(-3000));
    return {root,home,profile,port,token,cookie,fixture:fixtureData,close,stop:stopHost,getOutput:()=>redact(output)};
  } catch(error) {
    if (retainOnFailure) { await stopHost(); console.error('Retained synthetic diagnostic home: '+root); }
    else await close();
    throw error;
  }
}
