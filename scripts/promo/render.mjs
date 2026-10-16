import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.join(root,'docs/media');
const previews=path.join(root,'docs/media');
const verify=path.join(root,'docs/verification/promo');
await Promise.all([output,previews,verify].map(p=>mkdir(p,{recursive:true})));
const duration=21,fps=30;
const video=path.join(output,'culture-desk-promo.mp4');
const gif=path.join(previews,'culture-desk-promo.gif');
const poster=path.join(output,'culture-desk-promo-poster.png');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
await page.goto(pathToFileURL(path.join(root,'scripts/promo/promo.html')).href);
await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
const captures=[['start',0],['intro',2.7],['region',6.8],['middle',10.8],['refresh',15.5],['end',20.2]];
for(const [name,time] of captures){await page.evaluate(t=>window.renderFrame(t),time);await page.screenshot({path:path.join(verify,`${name}.png`)});}
await page.evaluate(()=>window.renderFrame(2.7));await page.screenshot({path:poster});
if(process.argv.includes('--frames-only')){await browser.close();console.log('Preview frames and poster ready.');process.exit(0);}
const encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',video],{cwd:root,windowsHide:true,stdio:['pipe','inherit','inherit']});
const encoderDone=once(encoder,'close');
try{
 for(let i=0;i<duration*fps;i++){
  await page.evaluate(t=>window.renderFrame(t),i/fps);
  const buffer=await page.screenshot({type:'jpeg',quality:94});
  if(!encoder.stdin.write(buffer))await once(encoder.stdin,'drain');
  if(i%90===0)console.log(`Rendered ${i}/${duration*fps} frames`);
 }
 encoder.stdin.end();const [code]=await encoderDone;if(code!==0)throw new Error(`ffmpeg exited ${code}`);
}finally{await browser.close();}
async function ffmpeg(args){const child=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{cwd:root,windowsHide:true,stdio:'inherit'});const [code]=await once(child,'close');if(code!==0)throw new Error(`ffmpeg exited ${code}`);}
await ffmpeg(['-i',video,'-filter_complex','fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle','-loop','0',gif]);
if((await stat(gif)).size>5*1024*1024)await ffmpeg(['-i',video,'-filter_complex','fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle','-loop','0',gif]);
for(const [name,time] of [['start',0],['middle',10.8],['end',20.2]])await ffmpeg(['-ss',String(time),'-i',video,'-frames:v','1',path.join(verify,`encoded-${name}.png`)]);
const files=await Promise.all([video,gif,poster].map(async name=>({file:path.relative(root,name).replaceAll('\\','/'),bytes:(await stat(name)).size})));
await writeFile(path.join(verify,'render.json'),JSON.stringify({duration,fps,width:1920,height:1080,audio:false,files,captures},null,2));
console.log(JSON.stringify({duration,fps,files},null,2));
