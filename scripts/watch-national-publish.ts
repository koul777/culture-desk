import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const directory=path.resolve(process.argv[2]||'data/national-20261001-20270116');
const progressFile=path.join(directory,'progress.json');
let last='';let stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
const publish=(checkpoint:string,batch:string)=>new Promise<{code:number;output:string}>(resolve=>{
  const child=spawn(process.execPath,['--import','tsx','scripts/publish-national.ts',checkpoint,batch],
    {cwd:process.cwd(),windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
  let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});
  child.on('error',()=>resolve({code:1,output:''}));
  child.on('close',code=>resolve({code:code??1,output}));
});
while(!stopping){
  try{
    const progress=JSON.parse(await readFile(progressFile,'utf8'));
    if(progress.checkpoint&&progress.checkpoint!==last){
      const result=await publish(progress.checkpoint,progress.batch);
      const report={at:new Date().toISOString(),checkpoint:progress.checkpoint,code:result.code,
        result:result.code===0?JSON.parse(result.output.trim()):{error:'Publication failed; retrying on next pass.'}};
      await writeFile(path.join(directory,'publication.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report));
      if(result.code===0)last=progress.checkpoint;
      if(progress.final&&!progress.interrupted&&result.code===0)break;
    }
    if(progress.final&&!progress.interrupted&&progress.checkpoint===last)break;
  }catch{console.log(JSON.stringify({at:new Date().toISOString(),error:'Waiting for a valid collection checkpoint.'}));}
  for(let n=0;n<12&&!stopping;n++)await new Promise(resolve=>setTimeout(resolve,10000));
}
