/** Branded monitor graphics. Slack retains a title-and-links list below the single dashboard image. */
import { Resvg } from '@resvg/resvg-js';
import { CONSORT_LOGO } from '../shared/consortLogo.ts';
const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const plain=(s:string)=>s.replace(/<https:\/\/[^|>]+\|([^>]+)>/g,'$1').replace(/[*`]/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').normalize('NFKC');
export type DashboardPanel={svg:string;alt:string;links?:string;action?:string;rank?:number;title?:string;metadata?:string;cost?:string;age?:string;accounts?:{name:string;peak?:number;blocked:boolean;detail:string}[]};
function wrap(s:string,width=83):string[]{
 const words=plain(s).split(/\s+/),lines:string[]=[];let line='';
 for(const word of words.flatMap(w=>w.length>width?w.match(new RegExp('.{1,'+width+'}','gu'))??[w]:[w])){if(line.length+word.length+1>width && line){lines.push(line);line='';}line+=(line?' ':'')+word;}
 if(line)lines.push(line);return lines;
}
function svg(height:number,body:string){return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}"><rect width="960" height="${height}" rx="4" fill="#121110"/><rect x=".5" y=".5" width="959" height="${height-1}" rx="4" fill="none" stroke="#494239"/>${body}</svg>`;}
function text(s:string,x:number,y:number,size=18,color='#f3ead6',serif=false){return `<text x="${x}" y="${y}" fill="${color}" font-family="${serif?'Georgia':'Arial'}" font-size="${size}">${esc(s.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu,'').trim())}</text>`;}
function logo(){return `<image x="24" y="19" width="66" height="66" href="data:image/png;base64,${CONSORT_LOGO}"/>`;}
export function dashboardPanels(safeText:string):DashboardPanel[]{
 const lines=safeText.split('\n');
 // A guard replacement must never be reconstructed into the original task content.
 if(!safeText.startsWith('*📊 Consort master monitor*'))return [{svg:svg(100,text(plain(safeText).slice(0,95),24,52)),alt:plain(safeText).slice(0,1900)}];
 const waiting=lines.filter(l=>/^🟠 /.test(l)).length,ready=lines.filter(l=>/^📦 /.test(l)).length,running=lines.filter(l=>/^🔄 /.test(l)).length;
 let head=logo()+text('Consort',106,64,40,'#f3ead6',true);
 for(const [i,n,label,color] of [[0,waiting,'Need your reply','#f5a044'],[1,ready,'Ready to merge','#e6d6b5'],[2,running,'In progress','#f3ead6']] as const){const x=24+i*306;head+=`<rect x="${x}" y="108" width="294" height="86" rx="3" fill="#1d1b19" stroke="#494239"/>`+text(String(n),x+16,144,29,color)+text(label,x+16,176,17);}
 const panels:DashboardPanel[]=[{svg:svg(216,head),alt:`Consort. ${waiting} need your reply; ${ready} ready to merge; ${running} in progress.`}];
 let section='';
 for(let i=3;i<lines.length;i++){
  const line=lines[i];if(line.startsWith('No ') || line.startsWith('… ')) { if(line.startsWith('… '))panels.push({svg:svg(80,text(plain(line),24,44)),alt:plain(line),rank:3});continue;}if(!line || line==='STATUS: MONITORING'||line.startsWith('Open a ticket title'))continue;
  if(/^\*[^*]+\*$/.test(line)){section=plain(line);continue;}
  if(section==='Accounts'){
   const rows=lines.slice(i).filter(l=>/^[🔴⚪🟢🟡🟠]/u.test(l));const accounts:NonNullable<DashboardPanel['accounts']>=[];let y=65;let body=text('AI capacity',24,35,23,'#f3ead6',true);
   for(const row of rows){const blocked=row.startsWith('🔴');const name=plain(row).replace(/^\S+ /,'').split(' · ')[0];const values=[...row.matchAll(/(\d+)%/g)].map(m=>Number(m[1]));const peak=values.length?Math.max(...values):undefined;const c=blocked?'#e99585':peak===undefined?'#bbb2a2':peak<=50?'#cfe0b8':peak<90?'#eed28b':'#f5a044';
    accounts.push({name,peak,blocked,detail:plain(row).replace(/^\S+ /,'').split(' · ').slice(1).join(' · ')});
    body+=text(name,24,y,17,c);
    if(blocked || peak===undefined){const detail=plain(row).replace(/^\S+ /,'').split(' · ').slice(1).join(' · ');for(const l of wrap(detail,80)){body+=text(l,155,y,15,'#bbb2a2');y+=23;}y+=12;}
    else {body+=`<rect x="155" y="${y-12}" width="690" height="8" rx="3" fill="#413c34"/><rect x="155" y="${y-12}" width="${690*Math.min(100,peak)/100}" height="8" rx="3" fill="${c}"/>`+text(`${peak}%`,870,y,17);y+=37;}
   }
   panels.push({svg:svg(y+20,body),alt:plain(rows.join('\n')).slice(0,1900),rank:4,accounts});break;
  }
  const details:string[]=[];while(lines[i+1]?.startsWith('   '))details.push(lines[++i].trim());
  const destinations=details.filter(d=>/<https:\/\//.test(d));const action=details.filter(d=>!destinations.includes(d)).join(' ');
  const parts=plain(line).replace(/^[^ ]+ /,'').split(' · ');const title=parts[1]??parts[0];const metadata=parts.length>=6?[parts[0],...parts.slice(2,-2)].join(' · '):parts.slice(2).join(' · ');const cost=parts.length>=6?parts.at(-2):undefined;const age=parts.length>=6?parts.at(-1):undefined;
  const thread=line.split(' · ')[1]?.match(/<(https:\/\/[^|>]+)\|[^>]+>/)?.[1];
  const links=[thread?`<${thread}|Slack ↗>`:'',...destinations.map(d=>d.replace(/\|ticket>/g,'|ClickUp ↗>').replace(/\|github>/g,'|GitHub ↗>').replace(/\|merge PR>/g,'|Merge PR ↗>'))].filter(Boolean).join(' · ');
  const titleLines=wrap(title,55),metaLines=wrap(metadata,76);let y=32;const attention=line.startsWith('🟠'),isReady=line.startsWith('📦');let body=text(attention?'Reply needed':isReady?'Ready to merge':section,24,y,15,attention?'#f5a044':'#bbb2a2');y+=32;
  if(age)body+=text(age,760,y,15,'#bbb2a2');if(cost)for(const [index,l] of wrap(cost,20).entries())body+=text(l,760,y+25+index*20,16);
  for(const l of titleLines){body+=text(l,24,y,23);y+=29;}
  for(const l of metaLines){body+=text(l,24,y,16,'#bbb2a2');y+=23;}
  if(action)for(const l of wrap(action,95)){body+=text(l,24,y+4,16,'#bbb2a2');y+=24;}
  const stage=metadata.match(/(\d+)\/(\d+)/);if(stage){y+=8;const n=Number(stage[1]),total=Number(stage[2]);if(total>0&&total<=30)for(let k=0;k<total;k++)body+=`<rect x="${24+k*912/total}" y="${y}" width="${912/total-5}" height="7" rx="1" fill="${k<(line.startsWith('📦')?n:n-1)?'#e6d6b5':'#413c34'}"/>`;y+=15;}
  panels.push({svg:svg(y+20,body),alt:plain([section,line,action].join('\n')).slice(0,1900),links,action,title,metadata,cost,age,rank:attention?0:isReady?1:section.startsWith('Completed')?3:2});
 }
 return [panels[0],...panels.slice(1).sort((a,b)=>(a.rank??2)-(b.rank??2))];
}
/** One SVG document becomes one Slack-compatible PNG; link rows stay native text. */
export function dashboardGraphic(panels:DashboardPanel[]):DashboardPanel{
 if(panels.length===1 && !panels[0].title && !panels[0].accounts && !panels[0].alt.startsWith('Consort.'))return panels[0];
 const tasks=panels.filter(p=>p.title),active=tasks.filter(p=>p.rank!==3),shown=active.slice(0,4),completed=tasks.filter(p=>p.rank===3).length;
 const accounts=panels.find(p=>p.accounts)?.accounts??[];
 const short=(s:string,n:number)=>{const value=plain(s).replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu,'').trim();return value.length>n?value.slice(0,n-1)+'…':value;};
 let body=logo()+text('Consort',106,64,38,'#f3ead6',true);
 const counts=[`${tasks.filter(p=>p.rank===0).length} need your reply`,`${tasks.filter(p=>p.rank===1).length} ready to merge`,`${tasks.filter(p=>p.rank===2).length} working`];
 for(let i=0;i<counts.length;i++)body+=text(counts[i],24+i*306,113,25,i===0?'#f5a044':'#f3ead6');
 let y=142;
 for(const task of shown){
  body+=`<path d="M24 ${y-8}H936" stroke="#38342e"/>`;
  body+=text(short(task.title!,53),24,y+21,25,task.rank===0?'#f5a044':'#f3ead6');
  if(task.cost)body+=text(short(task.cost,19),755,y+21,21);
  body+=text(short(task.metadata??'',87),24,y+50,21,'#ccc2b1');
  const stage=task.metadata?.match(/(\d+)\/(\d+)/);
  if(stage){const n=Number(stage[1]),total=Number(stage[2]);if(total>0&&total<=30)for(let k=0;k<total;k++)body+=`<rect x="${24+k*912/total}" y="${y+64}" width="${912/total-5}" height="5" rx="1" fill="${k<(task.rank===1?n:n-1)?'#e6d6b5':'#413c34'}"/>`;}
  y+=84;
 }
 if(!shown.length){body+=text('No active tasks',24,y+24,25);y+=48;}
 const extra=active.length-shown.length;
 body+=text(`${extra?extra+' more active · ':''}${completed} recently completed · task details and links below`,24,y+18,21,'#ccc2b1');y+=47;
 body+=text('AI capacity',24,y+15,26,'#f3ead6',true);y+=40;
 for(let i=0;i<accounts.length;i++){
  const a=accounts[i],x=24+(i%2)*462,rowY=y+Math.floor(i/2)*62;
  const color=a.blocked?'#e99585':a.peak===undefined?'#bbb2a2':a.peak<=50?'#cfe0b8':a.peak<90?'#eed28b':'#f5a044';
  body+=text(a.name,x,rowY,22,color);
  if(a.blocked){body+=text('BLOCKED',x+155,rowY,21,color);body+=text(short(a.detail.split(' · ')[0],43),x,rowY+23,18,'#ccc2b1');const resume=a.detail.match(/(?:resume after|resumes|resume time).*$/i)?.[0];if(resume)body+=text(short(resume,43),x,rowY+44,18,'#ccc2b1');}
  else if(a.peak===undefined)body+=text('usage unavailable',x+155,rowY,19,'#ccc2b1');
  else{body+=text(`${a.peak}%`,x+367,rowY,22);body+=`<rect x="${x}" y="${rowY+15}" width="416" height="8" rx="3" fill="#413c34"/><rect x="${x}" y="${rowY+15}" width="${416*Math.min(100,a.peak)/100}" height="8" rx="3" fill="${color}"/>`;}
 }
 y+=Math.ceil(accounts.length/2)*62;
 // Link rows retain full descriptions, completed work and blocked-account reset details.
 return {svg:svg(y+12,body),alt:panels.map(p=>p.alt).join('\n').slice(0,1900)};
}
export function dashboardPng(svg:string):Buffer{return Buffer.from(new Resvg(svg,{font:{loadSystemFonts:true,defaultFontFamily:'Arial'}}).render().asPng());}
