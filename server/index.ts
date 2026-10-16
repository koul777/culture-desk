import { readConfig } from './config.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';

const config=readConfig();
const unlock=acquireLock(config.databasePath);
let closing=false;
try {
  const {app}=await createApp(config,{searchOnly:true,allowLocalManagement:true,shutdown:()=>void close()});
  async function close(){if(closing)return;closing=true;await app.close();unlock();process.exit(0);}
  process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());process.on('exit',unlock);
  await app.listen({host:'127.0.0.1',port:config.port});
  console.log(`Culture Desk: http://127.0.0.1:${config.port}`);
} catch {
  unlock();console.error('Culture Desk를 시작할 수 없습니다. 포트 또는 실행 중인 프로그램을 확인하세요.');process.exitCode=1;
}
