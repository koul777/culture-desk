import { readConfig } from '../server/config.js';
import { restoreDatabase } from '../server/maintenance.js';
const config=readConfig();const input=process.argv[2];
if(!input)throw new Error('사용법: npm run restore -- data/backups/백업파일.db');
restoreDatabase(input,config.databasePath);
console.log('백업을 복원했습니다. 프로그램을 다시 실행하세요. 이전 자료도 보관했습니다.');
