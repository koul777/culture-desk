import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const portText=parse(readFileSync(path.join(root,'.env'))).PORT || process.env.PORT;
const port=portText&&Number.isFinite(Number(portText))?Math.floor(Math.max(1024,Math.min(65535,Number(portText)))):4317;
try { const response=await fetch(`http://127.0.0.1:${port}/api/shutdown`,{method:'POST',headers:{'X-Culture-Request':'1','Content-Type':'application/json'},body:'{}'}); if(!response.ok)process.exitCode=1; } catch { /* Already stopped. */ }
