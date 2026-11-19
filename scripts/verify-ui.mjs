// Run against an isolated, unauthenticated QA browser on port 9335 with extension loaded.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const version=await (await fetch('http://127.0.0.1:9335/json/version')).json();
const ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let next=0;const pending=new Map();
ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.id){const entry=pending.get(msg.id);pending.delete(msg.id);msg.error?entry.reject(new Error(JSON.stringify(msg.error))):entry.resolve(msg.result);}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});
try {
  const {targetInfos}=await send('Target.getTargets');
  const worker=targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'))??targetInfos.find(t=>t.type==='page'&&t.url.startsWith('chrome-extension://'));
  if(!worker)throw new Error('Isolated extension worker not found.');
  // URL.origin for chrome-extension URLs may be null in Node.
  const extensionBase=worker.url.slice(0,worker.url.lastIndexOf('/'));
  const {targetId}=await send('Target.createTarget',{url:extensionBase+'/popup.html'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const cdp=(method,params)=>send(method,params,sessionId);
  async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
  await cdp('Runtime.enable');
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  // Wait for the bundled UI without relying on a fixed timer.
  for(let i=0;i<30;i++){if(await evaluate('!!document.querySelector("button[type=submit]")'))break;await new Promise(r=>setTimeout(r,100));}
  await evaluate(`(async()=>{const {state}=await chrome.storage.local.get('state');await chrome.storage.local.set({state:{...state,group:'custom',productionEnabled:true,customDestination:{name:'QA team',id:'CT_qa',url:'https://cliq.zoho.com/company/717321507/chats/CT_qa'},status:'AVAILABLE',backPending:false},customDraft:{text:'',url:'',name:'',minutes:30,timing:'delay'},customJobs:[],destinations:[]});})()`);
  const axe=await readFile('node_modules/axe-core/axe.min.js','utf8');await evaluate(axe);
  await mkdir('docs/ui-preview',{recursive:true});
  const checks=[];
  for(const width of [390,340,300]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:650,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(requestAnimationFrame)');
    const geometry=await evaluate(`(()=>{const b=document.querySelector('button[type="submit"]').getBoundingClientRect();const nav=document.querySelector('.bottom-nav').getBoundingClientRect();return {width:innerWidth,height:innerHeight,buttonBottom:b.bottom,navTop:nav.top,scrollHeight:document.documentElement.scrollHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};})()`);
    const audit=await evaluate(`(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));})()`);
    checks.push({view:'today',...geometry,violations:audit});
    const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(`docs/ui-preview/compact-home-${width}.png`,Buffer.from(shot.data,'base64'));
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await evaluate(`[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('Custom Message')).click()`);
  for(let i=0;i<30;i++){if(await evaluate('!!document.querySelector("textarea")'))break;await new Promise(r=>setTimeout(r,100));}
  checks.push({view:'custom',violations:await evaluate(`(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));})()`)});
  const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile('docs/ui-preview/custom-messages.png',Buffer.from(shot.data,'base64'));
  // Exercise the rebuilt message form at narrow widths, including expanded URL fields.
  for(const width of [390,300]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:650,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(requestAnimationFrame)');
    checks.push({view:'custom-new',width,horizontalOverflow:await evaluate('document.documentElement.scrollWidth>innerWidth'),violations:await evaluate(`(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));})()`)});
  }
  const sample={destinations:[{name:'Daily updates',id:'CT_qa_reports',url:'https://cliq.zoho.com/company/717321507/chats/CT_qa_reports'}],customDraft:{text:'DSR — Today’s progress\n\n• Finished the landing page review\n• Prepared tomorrow’s campaign\n\nNext: share the final designs.',name:'Daily updates',url:'https://cliq.zoho.com/company/717321507/chats/CT_qa_reports',minutes:30,timing:'delay'}};
  await evaluate(`(async()=>{await chrome.storage.local.set(${JSON.stringify(sample)});[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Today').click();})()`);
  await evaluate(`[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('Custom Message')).click()`);
  for(let i=0;i<30;i++){if(await evaluate('!!document.querySelector("textarea")'))break;await new Promise(r=>setTimeout(r,100));}
  for(const width of [390,300]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:650,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(requestAnimationFrame)');
    checks.push({view:'custom-saved',width,horizontalOverflow:await evaluate('document.documentElement.scrollWidth>innerWidth'),violations:await evaluate(`(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));})()`)});
    const metrics=await cdp('Page.getLayoutMetrics');const full=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:Math.ceil(metrics.cssContentSize.height),scale:1}});
    await writeFile(`docs/ui-preview/custom-redesign-${width}.png`,Buffer.from(full.data,'base64'));
  }
  await evaluate(`document.querySelector('input[name="timing"][value="date"]').click()`);
  await evaluate('new Promise(requestAnimationFrame)');
  checks.push({view:'custom-date',width:300,horizontalOverflow:await evaluate('document.documentElement.scrollWidth>innerWidth'),violations:await evaluate(`(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));})()`)});
  const storedDraft=await evaluate(`(async()=>{await chrome.runtime.sendMessage({type:'GET_CUSTOM'});const {customDraft}=await chrome.storage.local.get('customDraft');return customDraft;})()`);
  if(storedDraft.timing!=='date'||storedDraft.text!==sample.customDraft.text)throw new Error('Date selection or multiline draft was not persisted.');
  checks.push({view:'draft-persistence',passed:true});
  const qaDestination=sample.destinations[0];const at=Date.now()-120_000;
  const sampleJobs=[{id:'qa-sent',text:sample.customDraft.text,destination:qaDestination,profile:{},scheduledAt:at,status:'sent',operation:null,detail:'Delivery confirmed in Cliq.'},{id:'qa-review',text:'A separate report awaiting review.',destination:qaDestination,profile:{},scheduledAt:at,status:'uncertain',operation:{id:'qa-op',kind:'custom',group:'custom',destination:qaDestination,text:'A separate report awaiting review.',startedAt:at},detail:'Check the exact message in Cliq before retrying.'}];
  await evaluate(`chrome.storage.local.set({customJobs:${JSON.stringify(sampleJobs)}})`);
  for(let i=0;i<30;i++){if(await evaluate('document.querySelectorAll(".message-job").length===2'))break;await new Promise(r=>setTimeout(r,100));}
  checks.push({view:'custom-outbox',width:300,horizontalOverflow:await evaluate('document.documentElement.scrollWidth>innerWidth'),violations:await evaluate(`(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}));})()`)});
  await writeFile('docs/ui-preview/compact-checks.json',JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));
} finally {ws.close();}
