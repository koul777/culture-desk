import type { Store } from './store.js';
import type { SearchFilters } from '../shared/types.js';
import type { Row, Worksheet } from 'exceljs';
import { writeWorkbookBuffer } from './export-stream.js';

const sourceName={kopis:'KOPIS',culture:'문화포털'};
export async function exportWorkbook(store: Store, filters: SearchFilters, ids?: number[], options: {includeNotes?:boolean} = {}) {
  // Caller-owned query inputs belong to the same snapshot as the selected rows.
  filters={...filters}; ids=ids?.slice();
  const includeNotes=options.includeNotes!==false;
  // All data and evidence are read synchronously before the asynchronous serialization step.
  const result=store.search(filters,true);
  const items=ids ? result.items.filter(p=>ids.includes(p.id)) : result.items;
  const runs=store.runs(10000); const counts=store.counts(); const cities=store.cities();
  const regionName=(id:string)=>{const c=cities.find(city=>city.id===id);return c?`${c.sido} ${c.sigungu}`:id;};
  // Ordinary searches do not need the spreadsheet parser. Capture the store reads
  // before awaiting its first load so callers can still release the database safely.
  const { default: ExcelJS } = await import('exceljs');
  return writeWorkbookBuffer(ExcelJS.stream.xlsx.WorkbookWriter, workbook=>{
  workbook.creator='Culture Desk'; workbook.created=new Date(result.snapshotAt);
  // Commit each formatted row so the workbook does not retain every cell object.
  // Data/evidence above remain the same synchronous snapshot as the document writer.
  const addRow=(sheet:Worksheet,values:unknown[])=>{
    const row:Row=sheet.addRow(values);
    if(row.number===1){
      row.font={bold:true,color:{argb:'FFFFFFFF'}};
      row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF164C43'}};
    }
    row.eachCell(cell=>{cell.alignment={vertical:'top',wrapText:true};});
    row.commit();
  };
  const sheet=workbook.addWorksheet('공연 목록',{views:[{state:'frozen',ySplit:1}]});
  const headers=['도시','공연명','시작일','종료일','장르','공연장','관람료 원문','요금 구분','관람 연령','공연 시간','출연진','제작','주최','연락처','출처','원문 링크','상세 상태','갱신 시각',...(includeNotes?['기획 메모']:[])];
  sheet.columns=headers.map((_,i)=>({width:i===1?42:i===15?55:i===18?55:18}));
  sheet.autoFilter={from:'A1',to:includeNotes?'S1':'R1'};
  addRow(sheet,headers);
  for(const p of items) addRow(sheet,[regionName(p.cityId),p.title,p.startDate,p.endDate,p.genre,p.venue,p.price||'정보 미상',p.priceType==='free'?'무료':p.priceType==='paid'?'유료':'정보 미상',p.age||'정보 미상',p.runtime||'정보 미상',p.cast,p.producer,p.organizer,p.contact,sourceName[p.source],p.sourceUrl,p.detailState==='complete'?'수집 완료':p.detailState==='failed'?'수집 실패':'상세 미수집',p.updatedAt,...(includeNotes?[p.note]:[])]);
  sheet.commit();
  const evidence=workbook.addWorksheet('조회 근거');
  evidence.columns=Array.from({length:11},(_,i)=>({width:i===1?65:24}));
  for(const values of [
    ['항목','내용'], ['추출 시각',result.snapshotAt],['조회 조건',JSON.stringify(filters)],['선택 항목',ids?.join(', ')||'전체 검색 결과'],
    ['자료 상태',result.partial?'부분 자료: 수집 범위 또는 상세정보가 완전하지 않습니다.':'선택 범위 수집 완료'],
    ['목록 행 수',String(items.length)],['KOPIS 등록 자료',String(items.filter(p=>p.source==='kopis').length)],['문화포털 등록 자료',String(items.filter(p=>p.source==='culture').length)],
    ['집계 주의','서로 다른 출처의 같은 공연이 포함될 수 있습니다. 합계는 고유 공연 수가 아닙니다.'],
    ['상세 미완료 건수(기본 조건)',String(result.pendingDetails)],['전시 등 제외(보관된 전체)',String(counts.excluded)],['분류 검토 대기(보관된 전체)',String(counts.review)],
    ['범위 주의','등록 자료 0건은 해당 도시의 공연이 없다는 의미가 아닙니다.'],['관람료 주의','관람료는 관객의 입장 가격입니다. 제작비·섭외비가 아닙니다.'],
    [],['출처','도시','시작일','종료일','수집 상태','완료 작업','전체 작업','전시 등 제외','검토 대기','갱신 시각','오류'],
    ...runs.filter(r=>(!filters.source||filters.source===r.source)&&(!filters.cities||filters.cities.split(',').includes(r.cityId))&&(!filters.from||r.to>=filters.from)&&(!filters.to||r.from<=filters.to))
      .map(r=>[sourceName[r.source],regionName(r.cityId),r.from,r.to,r.state,String(r.tasksDone),String(r.tasksTotal),String(r.excluded),String(r.review),r.updatedAt,r.error]),
  ]) addRow(evidence,values);
  evidence.commit();
  });
}
