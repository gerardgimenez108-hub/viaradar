import "./style.css";
import type { Board, Departure, Platform } from "../server/model.ts";
import { isBoard } from "./board-contract.ts";
import { shell } from "./shell.ts";
import {readPreference,savePreference,resolveLanguage,translate,formatTime,formatTimestamp,formatNumber,formatPercent,type MessageKey,type LanguagePreference,type PreferenceStorage} from "./i18n.ts";
const app=document.querySelector<HTMLDivElement>("#app")!;
function storage():PreferenceStorage|undefined {try{return window.localStorage;}catch{return undefined;}}
let preference=readPreference(storage());
let language=resolveLanguage(preference,navigator.languages?.length?navigator.languages:[navigator.language]);
const t=(key:MessageKey,values:Record<string,string|number>={})=>translate(language,key,values);
const time=(iso:string)=>formatTime(language,iso);
const stamp=(iso:string)=>formatTimestamp(language,iso);
const number=(value:number)=>formatNumber(language,value);
const percent=(value:number)=>formatPercent(language,value);
const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const apiBase=(import.meta.env.VITE_API_BASE_URL||"").replace(/\/+$/,"");
let board:Board|null=null;
let failed=false;
let busy=false;
let line="";
let list:HTMLDivElement;
let status:HTMLDivElement;
let select:HTMLSelectElement;
let refresh:HTMLButtonElement;
function evidence(platform:Platform,cancelled:boolean):string {
 if(cancelled||platform.evidenceCode==='cancelled')return t('cancelEvidence');
 if(platform.kind==='official'){
  const context=platform.evidenceContext;
  return context?.stationId&&context.observedAt&&Number.isFinite(Date.parse(context.observedAt))?t('officialContext',{station:context.stationId,time:stamp(context.observedAt)}):t('officialEvidence');
 }
 if(platform.kind==='prediction')return t('predictionEvidence',{percent:percent(platform.confidence||0),count:number(platform.sampleCount)});
 return t(platform.evidenceCode==='variable_history'?'variableEvidence':'unknownEvidence');
}
function row(original:Departure,stale:boolean):string {
 const d=stale?{...original,expectedAt:original.scheduledAt,realtime:false}:original;
 const platform=stale?{...d.platform,kind:'unknown',value:null}:d.platform;
 const delay=Math.round((Date.parse(d.expectedAt)-Date.parse(d.scheduledAt))/60000);
 const timing=d.cancelled?t(stale?'previouslyCancelled':'cancelled'):d.realtime?(delay>0?t('liveDelay',{minutes:number(delay)}):t('liveEstimate')):t('scheduled');
 const detail=d.cancelled?t(stale?'previousCancellation':'doNotBoard'):t(d.realtime?'updatedTime':'timetableTime');
 return `<article class="departure ${d.cancelled?'cancelled':''}"><div class="departure-time"><strong>${time(d.expectedAt)}</strong><small>${timing}</small>${delay>0?`<s>${time(d.scheduledAt)}</s>`:''}</div><div class="destination"><span class="line">${escape(d.line)}</span><h3>${escape(d.destinationUnavailable?t('unknownDestination'):d.destination)}</h3><small>${detail}</small></div><div class="platform ${platform.kind}"><strong>${platform.value?escape(platform.value):'—'}</strong><small>${t(platform.kind==='official'?'published':platform.kind==='prediction'?'estimate':'notPublished')}</small>${platform.kind==='prediction'?`<span>${t('share',{percent:percent(platform.confidence||0),count:number(platform.sampleCount)})}</span>`:''}</div><details class="evidence" data-service="${escape(`${d.serviceDate}:${d.tripId}`)}"><summary>${t('sourceDetails')}</summary><p>${escape(stale?t('staleEvidence'):evidence(d.platform,d.cancelled))}</p><p>${t('service')} ${escape(d.tripId)} · ${escape(d.serviceDate)}</p></details></article>`;
}
function preserveDetails():Set<string> {return new Set(Array.from(app.querySelectorAll<HTMLDetailsElement>('details.evidence[open]')).map(el=>el.dataset.service!));}
function renderRows(html:string,opened=preserveDetails()):void {
 const active=document.activeElement;
 const focused=active?.tagName==='SUMMARY'?active.closest<HTMLDetailsElement>('details.evidence')?.dataset.service:undefined;
 list.innerHTML=html;
 for(const detail of Array.from(list.querySelectorAll<HTMLDetailsElement>('details.evidence'))){
  if(opened.has(detail.dataset.service!))detail.open=true;
  if(focused===detail.dataset.service)detail.querySelector('summary')?.focus({preventScroll:true});
 }
}
function filters():void {
 const values=[...new Set(board?.departures.map(d=>d.line)||[])].sort();
 select.innerHTML=`<option value="">${t('allLines')}</option>`+values.map(value=>`<option value="${escape(value)}">${escape(value)}</option>`).join('');
 if(!values.includes(line))line='';
 select.value=line;
}
function render():void {
 if(!board){
  if(failed){status.className='connection warning';status.textContent=t('cannotReach');renderRows(`<div class="empty"><span class="empty-icon">↗</span><h3>${t('unavailable')}</h3><p>${t('retry')}</p></div>`);}
  return;
 }
 const stale=failed||!navigator.onLine||Date.now()-Date.parse(board.generatedAt)>90000||board.sources.some(source=>source.healthy&&source.feedTimestamp&&Date.now()-Date.parse(source.feedTimestamp)>90000);
 const healthy=!stale&&board.sources.every(s=>s.healthy);
 status.className=`connection ${healthy?'good':'warning'}`;
 status.textContent=t(stale?'offlineStatus':healthy?'liveStatus':'limitedStatus');
 const rows=board.departures.filter(d=>!line||d.line===line);
 renderRows(rows.length?rows.map(d=>row(d,stale||(d.platform.kind==='official'&&!!d.platform.expiresAt&&Date.now()>Date.parse(d.platform.expiresAt)))).join(''):`<div class="empty"><span class="empty-icon">↗</span><h3>${t(line?'emptyLine':'empty')}</h3><p>${t(board.staticImportedAt?'emptyBody':'missingTimetable')}</p><p>${t('noInvented')}</p></div>`);
 document.querySelector('#updated')!.textContent=t('lastChecked',{time:time(board.generatedAt)})+(stale?t('outdated'):'');
 document.querySelector('#sources')!.innerHTML=board.sources.map(s=>`<p><strong>${t(s.kind==='vehicle_positions'?'vehicles':s.kind==='trip_updates'?'updates':'source')}</strong> · ${t(s.healthy&&!stale?'connected':'sourceUnavailable')}<br><small>${s.feedTimestamp?t('feedTime',{time:stamp(s.feedTimestamp)}):t('noFeed')}${s.error?` · ${t('feedError')}`:''}</small></p>`).join('')+`<p>${t('imported',{time:board.staticImportedAt?stamp(board.staticImportedAt):t('notImported')})}</p>`;
}
function renderShell():void {
 const opened=preserveDetails();
 const sourceOpen=app.querySelector<HTMLDetailsElement>('details.details')?.open||false;
 const dialogOpen=app.querySelector<HTMLDialogElement>('#install-dialog')?.open||false;
 const focusedId=(document.activeElement as HTMLElement|null)?.id;
 app.innerHTML=shell(t);
 document.documentElement.lang=language;
 document.title=t('title');
 const manifest=document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
 if(manifest)manifest.href=language==='es'?'/manifest.es.webmanifest':'/manifest.webmanifest';
 list=app.querySelector<HTMLDivElement>('#departures')!;
 status=app.querySelector<HTMLDivElement>('#connection')!;
 select=app.querySelector<HTMLSelectElement>('#line')!;
 refresh=app.querySelector<HTMLButtonElement>('#refresh')!;
 const languageSelect=app.querySelector<HTMLSelectElement>('#language')!;
 languageSelect.value=preference;
 languageSelect.addEventListener('change',()=>{
  preference=['auto','es','en'].includes(languageSelect.value)?languageSelect.value as LanguagePreference:'auto';
  savePreference(preference,storage());applyLanguage();
 });
 refresh.disabled=busy;
 refresh.addEventListener('click',()=>void load());
 select.addEventListener('change',()=>{line=select.value;render();});
 app.querySelector('#install')!.addEventListener('click',()=>app.querySelector<HTMLDialogElement>('#install-dialog')!.showModal());
 filters();render();
 app.querySelector<HTMLDetailsElement>('details.details')!.open=sourceOpen;
 for(const detail of Array.from(app.querySelectorAll<HTMLDetailsElement>('details.evidence')))if(opened.has(detail.dataset.service!))detail.open=true;
 if(dialogOpen)app.querySelector<HTMLDialogElement>('#install-dialog')!.showModal();
 if(focusedId)document.getElementById(focusedId)?.focus({preventScroll:true});
}
function applyLanguage():void {language=resolveLanguage(preference,navigator.languages?.length?navigator.languages:[navigator.language]);renderShell();}
async function load():Promise<void>{
 if(busy)return;busy=true;refresh.disabled=true;
 try{
  const response=await fetch(`${apiBase}/api/departures?stationId=72305`,{cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const candidate:unknown=await response.json();if(!isBoard(candidate))throw new Error('Invalid departure response');
  board=candidate;failed=false;filters();render();
 }catch{failed=true;render();}finally{busy=false;refresh.disabled=false;}
}
renderShell();
window.addEventListener('languagechange',()=>{if(preference==='auto')applyLanguage();});
window.addEventListener('offline',render);
window.addEventListener('online',()=>void load());
void load();setInterval(()=>void load(),20000);setInterval(render,10000);
if('serviceWorker'in navigator&&!import.meta.env.DEV)navigator.serviceWorker.register('/sw.js').catch(console.warn);
