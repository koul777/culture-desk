import { createServer } from 'vite';
import { readConfig } from '../server/config.js';
await import('../server/index.js');
const {port}=readConfig();
const vite=await createServer({server:{proxy:{'/api':`http://127.0.0.1:${port}`}}});
await vite.listen(); vite.printUrls();
