import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createCultureProvider } from '../server/providers/culture.js';
import { createKopisProvider } from '../server/providers/kopis.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { classifyKopis, inferPriceType, resolveCityId, provinceShortName } from '../server/providers/classify.js';
import { toIsoDate } from '../server/providers/dates.js';
import { fetchText } from '../server/providers/fetch.js';
const fixture=(file:string)=>readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8');
const city=DEFAULT_CITIES[0];
const request={city,from:'2026-05-01',to:'2026-05-20',page:1,pageSize:100};

test('full numeric prices and mixed free/paid admissions',()=>{
  for(const price of ['1000원','50000원','50,000원','무료 (성인 1000원)','어린이 0원, 성인 50000원'])assert.equal(inferPriceType(price),'paid',price);
  for(const price of ['0원','무료','전석 0 원'])assert.equal(inferPriceType(price),'free',price);
  assert.equal(inferPriceType('문의'),'unknown');
});
test('recognized circus name and province evidence never override wrong municipality',()=>{
  assert.equal(classifyKopis({genrenm:'서커스/마술'}).classification,'performance');
  assert.ok(resolveCityId(city,{address:'경상북도 포항시 남구'}).reviewReason);
  assert.equal(resolveCityId(city,{areaText:'경북',address:'경북'}).reviewReason,'');
  assert.ok(resolveCityId(city,{sigungu:'포항시',address:'경상북도'}).reviewReason);
});
test('real calendar dates only',()=>{
  assert.equal(toIsoDate('2026-02-30'),'');
  assert.equal(toIsoDate('2026.2.3'),'2026-02-03');
  assert.equal(toIsoDate('20240229'),'2024-02-29');
  assert.equal(toIsoDate('20260229'),'');
});
test('culture request uses official eight-digit dates and short province name',async()=>{
  let seen='';
  const provider=createCultureProvider('REGRESSION_KEY',{fetch:async url=>{seen=url;return new Response(fixture('culture-area-page.xml'));}});
  await provider.list(request);
  const query=new URL(seen).searchParams;
  assert.equal(query.get('from'),'20260501');assert.equal(query.get('to'),'20260520');
  assert.equal(query.get('sido'),'경북');assert.equal(query.get('sigungu'),'안동시');
});
test('KOPIS rows retain official working source URL and reject missing identity',async()=>{
  const xml=fixture('kopis-list-multi.xml');
  const provider=createKopisProvider('REGRESSION_KEY',{fetch:async()=>new Response(xml)});
  const result=await provider.list(request);
  const link=new URL(result.items[0].sourceUrl);
  assert.equal(link.pathname,'/por/db/pblprfr/pblprfrView.do');
  assert.equal(link.searchParams.get('mt20Id'),result.items[0].sourceId);
  const invalid=createKopisProvider('REGRESSION_KEY',{fetch:async()=>new Response(xml.replace(/<mt20id>.*?<\/mt20id>/g,'<mt20id/>'))});
  await assert.rejects(()=>invalid.list(request),{kind:'schema'});
});
test('network exceptions cannot expose keys and already aborted requests do not fetch',async()=>{
  await assert.rejects(()=>fetchText('https://example.invalid',undefined,{fetch:async()=>{throw new Error('service=SECRET');}}),e=>!String(e).includes('SECRET'));
  let called=false;const abort=new AbortController();abort.abort();
  await assert.rejects(()=>fetchText('https://example.invalid',abort.signal,{fetch:async()=>{called=true;return new Response('');}}));
  assert.equal(called,false);
});
test('secret echoed into a display field is rejected before persistence',async()=>{
  const provider=createKopisProvider('REGRESSION_KEY',{fetch:async()=>new Response(fixture('kopis-list-multi.xml').replace(/<prfnm>.*?<\/prfnm>/,'<prfnm>REGRESSION_KEY</prfnm>'))});
  await assert.rejects(()=>provider.list(request),{kind:'schema'});
});

test('merged province names do not count as a mismatched municipality',()=>{
  const yeosu=DEFAULT_CITIES.find(c=>c.id==='yeosu')!;
  assert.equal(yeosu.kopisSido,'12');assert.equal(yeosu.kopisSigungu,'1213');
  assert.equal(DEFAULT_CITIES.find(c=>c.id==='suncheon')!.kopisSigungu,'1215');
  assert.equal(provinceShortName(yeosu.sido),'광주');
  for(const areaText of ['전남광주통합특별시','전라남도','전남','광주'])assert.equal(resolveCityId(yeosu,{areaText}).reviewReason,'',areaText);
  assert.ok(resolveCityId(yeosu,{address:'전남광주통합특별시 순천시 중앙로'}).reviewReason);
});

test('both providers request current Yeosu region and retain province-only KOPIS rows',async()=>{
  const yeosu=DEFAULT_CITIES.find(c=>c.id==='yeosu')!;
  let kQuery=new URLSearchParams();let cQuery=new URLSearchParams();
  const kopis=createKopisProvider('REGRESSION_KEY',{fetch:async url=>{kQuery=new URL(url).searchParams;return new Response('<dbs><db><mt20id>TEST-MERGED</mt20id><prfnm>TEST 공연</prfnm><prfpdfrom>2026.10.01</prfpdfrom><prfpdto>2026.10.02</prfpdto><genrenm>연극</genrenm><area>전남광주통합특별시</area></db></dbs>');}});
  const result=await kopis.list({...request,city:yeosu});
  assert.equal(kQuery.get('signgucode'),'12');assert.equal(kQuery.get('signgucodesub'),'1213');
  assert.equal(result.items[0].classification,'performance');assert.equal(result.items[0].cityId,'yeosu');
  const culture=createCultureProvider('REGRESSION_KEY',{fetch:async url=>{cQuery=new URL(url).searchParams;return new Response('<response><header><resultCode>00</resultCode></header><body><totalCount>0</totalCount><items/></body></response>');}});
  await culture.list({...request,city:yeosu});assert.equal(cQuery.get('sido'),'광주');assert.equal(cQuery.get('sigungu'),'여수시');
});
