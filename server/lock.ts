import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export function acquireLock(databasePath:string) {
  const file=databasePath+'.lock'; mkdirSync(path.dirname(file),{recursive:true});
  if(existsSync(file)) {
    let pid=0; try{pid=Number(JSON.parse(readFileSync(file,'utf8')).pid);}catch{}
    let alive=false; if(pid>0)try{process.kill(pid,0);alive=true;}catch{}
    if(alive)throw new Error('프로그램이 이미 실행 중입니다. 먼저 종료하세요.');
    unlinkSync(file);
  }
  const value=JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()});writeFileSync(file,value,{flag:'wx'});
  return ()=>{try{if(readFileSync(file,'utf8')===value)unlinkSync(file);}catch{}};
}
