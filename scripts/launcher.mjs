import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const portText=parse(readFileSync(path.join(root,'.env'))).PORT || process.env.PORT;
const port=portText&&Number.isFinite(Number(portText))?Math.floor(Math.max(1024,Math.min(65535,Number(portText)))):4317;
const url=`http://127.0.0.1:${port}`;
const logs=path.join(root,'logs'); mkdirSync(logs,{recursive:true});
const ready=async()=>{try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(800)});return r.ok&&(await r.json()).app==='culture-desk';}catch{return false;}};
try {
  if(!existsSync(path.join(root,'node_modules/tsx'))||!existsSync(path.join(root,'dist/client/index.html'))) throw new Error('먼저 npm install 및 npm run build를 실행하세요.');
  if(!await ready()) {
    const log=openSync(path.join(logs,'server.log'),'a');
    const server=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:root,windowsHide:true,shell:false,detached:true,stdio:['ignore',log,log]});
    server.unref();closeSync(log);
    for(let i=0;i<40&&!await ready();i++)await new Promise(resolve=>setTimeout(resolve,300));
    if(!await ready())throw new Error('서버를 시작하지 못했습니다. logs/server.log를 확인하세요.');
  }
  if(process.platform==='win32')spawn(path.join(process.env.WINDIR||'C:/Windows','explorer.exe'),[url],{windowsHide:true,shell:false,detached:true,stdio:'ignore'}).unref();
  else console.log(url);
}catch(error){writeFileSync(path.join(logs,'launcher-error.txt'),String(error.message),'utf8');process.exitCode=1;}
