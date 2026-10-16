import { copyFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock } from './lock.js';

export function restoreDatabase(input:string, target:string) {
  const source=path.resolve(input);const destination=path.resolve(target);
  if(source===destination)throw new Error('현재 데이터 파일은 복원 원본으로 사용할 수 없습니다.');
  const unlock=acquireLock(destination);
  try {
    const check=new DatabaseSync(source,{readOnly:true});
    try {
      const status=check.prepare('PRAGMA integrity_check').get() as Record<string,string>;
      if(Object.values(status)[0]!=='ok')throw new Error('백업 파일 무결성 검사 실패');
      const version=check.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number};
      if(version.version!==1)throw new Error('지원하지 않는 백업 버전입니다.');
      check.prepare('SELECT id FROM performances LIMIT 1').all();
    } finally { check.close(); }
    const staged=destination+'.restore-'+Date.now();copyFileSync(source,staged);
    let previous:string|null=null;
    if(existsSync(destination)) {
      const old=new DatabaseSync(destination);try{old.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{old.close();}
      previous=destination+'.before-restore-'+Date.now()+'.db';renameSync(destination,previous);
    }
    try { renameSync(staged,destination); }
    catch(error) { if(previous&&!existsSync(destination))renameSync(previous,destination);throw error; }
    return {previous};
  } finally { unlock(); }
}
