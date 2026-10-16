// Browser QA only: isolated in-memory database; every event is visibly TEST data.
// This entry point is never used by the Windows launcher or npm start.
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { today, addDays } from '../server/dates.js';
import type { PerformanceInput, Provider } from '../shared/types.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot=realpathSync(os.tmpdir());
const testDirectory=mkdtempSync(path.join(tempRoot,'culture-ui-test-'));
const store=new Store(':memory:',DEFAULT_CITIES);
for(let i=0;i<36;i++) {
  const item:PerformanceInput={source:i%2?'culture':'kopis',sourceId:`TEST-UI-${i}`,title:`TEST 검증용 ${i%3?'실내악 공연':'가족 연극'} ${i+1}`,
    cityId:DEFAULT_CITIES[i%7].id,startDate:addDays(today(),i-10),endDate:addDays(today(),i-9),genre:i%3?'음악':'연극',sourceGenre:i%3?'음악/콘서트':'연극',
    venue:'TEST 가상 공연장',address:'TEST 실제 장소가 아닙니다',poster:'',sourceUrl:'https://example.invalid/TEST',price:i%3?'50,000원':'무료',priceType:i%3?'paid':'free',
    age:'전체 관람가',runtime:'80분',cast:'TEST 출연진',producer:'TEST 제작사',organizer:'TEST 주최',contact:'',schedule:'토요일 15:00',
    description:'브라우저 검증만을 위한 가상 자료입니다. 실제 공연 정보가 아닙니다.',status:'공연예정',detailState:i===0?'pending':'complete',classification:'performance',reviewReason:'',raw:{test:true}};
  const id=store.upsert(item);if(i<3)store.bookmark(id,true,'TEST 사전 메모');
}
const provider=(source:'kopis'|'culture'):Provider=>({source,list:async()=>({items:[],hasMore:false}),detail:async item=>({...item,detailState:'complete'})});
const {app}=await createApp({port:4321,databasePath:path.join(testDirectory,'unused.db'),keys:{kopis:'',culture:''},requestIntervalMs:100,syncIntervalHours:720},
  {store,providers:{kopis:provider('kopis'),culture:provider('culture')},startWorker:false,shutdown:()=>void close()});
await app.listen({host:'127.0.0.1',port:4321});
console.log('Isolated TEST UI server: http://127.0.0.1:4321');
async function close(){await app.close();store.close();const resolved=realpathSync(testDirectory);if(path.dirname(resolved)===tempRoot&&path.basename(resolved).startsWith('culture-ui-test-'))rmSync(resolved,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());
