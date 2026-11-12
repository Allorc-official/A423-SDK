// Documentation-only fixed layouts: no automatic graph routing or crossed connectors.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Resvg} from '@resvg/resvg-js';
const directory=process.argv[2]?path.resolve(process.argv[2]):path.dirname(fileURLToPath(import.meta.url));
const W=1280,M=48,I=W-M*2;
const C={ink:'#172033',muted:'#536176',line:'#dbe3ee',bg:'#f6f8fc',blue:'#2455c7',blueBg:'#edf3ff',amber:'#936100',amberBg:'#fff6dc',purple:'#6940b3',purpleBg:'#f3edff',green:'#19724c',greenBg:'#eaf8f0',red:'#ad342b',redBg:'#fff0ee'};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
let out=[];
function rect(x,y,w,h,fill='white',stroke=C.line,r=12){out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);}
function text(x,y,value,{size=20,fill=C.ink,weight=400,max=I}={}){out.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" data-max-width="${max}">${esc(value)}</text>`);}
function lines(x,y,values,options={}){values.forEach((value,i)=>text(x,y+i*(options.leading||27),value,options));}
function label(y,value){text(M,y,value,{size:15,weight:700,fill:C.muted});}
function arrow(x1,y1,x2,y2){out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9baac0" stroke-width="2" marker-end="url(#arrow)"/>`);}
function begin(data,h){out=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="title desc" font-family="DejaVu Sans, sans-serif"><title id="title">${esc(data.title)}</title><desc id="desc">${esc(data.subtitle)}</desc><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#9baac0"/></marker></defs><rect width="${W}" height="${h}" fill="${C.bg}"/>`];text(M,33,'A423  /  PROTOCOL GUIDE',{size:14,fill:C.blue,weight:700});text(M,79,data.title,{size:34,weight:700});text(M,116,data.subtitle,{size:19,fill:C.muted});}
function finish(){return out.join('\n')+'\n</svg>\n';}
function cards(items,y,{height=130,fill='white',accent=C.blue,numbered=false}={}){const gap=24,w=(I-(items.length-1)*gap)/items.length;items.forEach((item,i)=>{const x=M+i*(w+gap);rect(x,y,w,height,fill);rect(x+20,y+20,numbered?32:5,numbered?30:28,accent,accent,numbered?8:2);text(x+(numbered?64:38),y+43,item.title,{size:22,weight:700,max:w-(numbered?84:58)});if(numbered)text(x+29,y+42,String(i+1),{size:18,weight:700,fill:'white',max:20});lines(x+20,y+77,item.lines||[],{size:19,fill:C.muted,max:w-40,leading:27});});return {width:w,gap};}
function table(y,widths,headers,rows,{rowHeight=82,headerHeight=52}={}){
 const total=headerHeight+rows.length*rowHeight;rect(M,y,I,total,'white',C.line,12);
 rect(M,y,I,headerHeight,'#eaf0f8','none',12);
 let x=M;headers.forEach((v,i)=>{text(x+20,y+34,v,{size:18,weight:700,fill:C.muted,max:widths[i]-40});x+=widths[i];});
 rows.forEach((row,r)=>{const top=y+headerHeight+r*rowHeight;if(r%2===1)rect(M+1,top,I-2,rowHeight,'#fafbfd','none',0);out.push(`<line x1="${M}" y1="${top}" x2="${M+I}" y2="${top}" stroke="${C.line}"/>`);let x=M;row.forEach((values,i)=>{const list=Array.isArray(values)?values:[values];const first=top+(rowHeight-(list.length-1)*27)/2+7;lines(x+20,first,list,{size:19,weight:i===2?600:400,max:widths[i]-40,leading:27});x+=widths[i];});});
}
function architecture(data){begin(data,1160);data.layers.forEach((layer,i)=>{const y=146+i*184;label(y+19,layer.label);const fills=['white',C.blueBg,C.purpleBg,C.amberBg,C.greenBg],accents=[C.blue,C.blue,C.purple,C.amber,C.green];cards(layer.cards,y+37,{height:116,fill:fills[i],accent:accents[i]});if(i<data.layers.length-1)arrow(W/2,y+162,W/2,y+181);});text(M,1123,data.footer,{size:18,fill:C.muted});return finish();}
function lifecycle(data){begin(data,1240);label(159,'PRIMARY PATH');const y=180,gap=24,w=(I-gap*3)/4,colors=[C.blue,C.amber,C.purple,C.green],fills=[C.blueBg,C.amberBg,C.purpleBg,C.greenBg];data.phases.forEach((phase,i)=>{const x=M+i*(w+gap);rect(x,y,w,282,fills[i]);text(x+20,y+34,`0${i+1}`,{size:16,weight:700,fill:colors[i],max:50});text(x+20,y+68,phase.title,{size:24,weight:700,max:w-40});phase.states.forEach((state,s)=>text(x+20,y+111+s*30,state,{size:21,fill:colors[i],weight:600,max:w-40}));lines(x+20,y+211,phase.notes,{size:18,fill:C.muted,max:w-40,leading:24});if(i<3)arrow(x+w+5,y+142,x+w+gap-5,y+142);});label(512,'EXCEPTIONS AND ALTERNATIVE ROUTES');table(534,[380,414,390],data.headers,data.routes,{rowHeight:76});lines(M,1171,data.footnotes,{size:17,fill:C.muted,leading:27});return finish();}
function cancellation(data){begin(data,1050);const laneWidth=156,cw=(I-laneWidth)/4,top=163,head=67,row=151;
 data.phases.forEach((phase,c)=>{const x=M+laneWidth+c*cw;rect(x+4,top,cw-8,head,C.blueBg,'none',10);text(x+19,top+40,`${c+1}  ${phase}`,{size:22,weight:700,max:cw-38});});
 data.lanes.forEach((lane,r)=>{const y=top+head+12+r*row;rect(M,y,I,row-10,'white');rect(M,y,laneWidth-8,row-10,r===2?C.amberBg:'#eaf0f8','none');lines(M+18,y+57,lane.name,{size:21,weight:700,max:laneWidth-36});lane.cells.forEach((cell,c)=>{const x=M+laneWidth+c*cw;if(c>0)out.push(`<line x1="${x}" y1="${y+18}" x2="${x}" y2="${y+row-28}" stroke="${C.line}"/>`);lines(x+18,y+54,cell,{size:18,fill:C.muted,max:cw-36,leading:29});});});
 label(740,'TWO DIFFERENT RECORDS');const recordY=760,w=(I-24)/2;data.records.forEach((record,i)=>{const x=M+i*(w+24);rect(x,recordY,w,115,i===0?C.amberBg:C.greenBg);text(x+22,recordY+33,record.title,{size:23,weight:700,max:w-44});lines(x+22,recordY+66,record.lines,{size:18,fill:C.muted,max:w-44,leading:25});});
 lines(M,919,data.exceptions,{size:18,fill:C.muted,leading:30});text(M,1021,data.footer,{size:17,fill:C.muted});return finish();}
function reopening(data){begin(data,1050);label(159,'CHOOSE THE MATCHING RULE');table(181,[450,330,404],data.headers,data.rows,{rowHeight:91});label(744,'AFTER ALL REQUIRED APPROVALS');const layout=cards(data.steps,765,{height:141,fill:C.greenBg,accent:C.green});for(let i=0;i<3;i++){const x=M+i*(layout.width+layout.gap);arrow(x+layout.width+5,835,x+layout.width+layout.gap-5,835);}lines(M,963,data.footnotes,{size:18,fill:C.muted,leading:31});return finish();}
for(const [name,render] of Object.entries({architecture,'job-lifecycle':lifecycle,cancellation,reopening})){
 const data=JSON.parse(fs.readFileSync(path.join(directory,name+'.json'),'utf8'));const svg=render(data);fs.writeFileSync(path.join(directory,name+'.svg'),svg);
 const png=new Resvg(svg,{background:'white',fitTo:{mode:'width',value:2200},font:{loadSystemFonts:true,defaultFontFamily:'DejaVu Sans'}}).render();fs.writeFileSync(path.join(directory,name+'.png'),png.asPng());console.log(`${name}: ${png.width}x${png.height}`);
}
