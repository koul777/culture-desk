import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { readConfig } from '../server/config.js';
const config=readConfig();
const directory=path.join(path.dirname(config.databasePath),'backups');mkdirSync(directory,{recursive:true});
const target=path.join(directory,`culture-${new Date().toISOString().replace(/[:.]/g,'-')}.db`);
const db=new DatabaseSync(config.databasePath,{readOnly:true});
try { await backup(db,target);console.log(target); } finally { db.close(); }
