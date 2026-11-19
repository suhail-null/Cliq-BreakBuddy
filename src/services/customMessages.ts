import {LATE_GRACE_MS,parseCustomDestination} from '../config';
import type {Command,CustomData,CustomDraft,CustomJob,Destination,Operation,Profile,Receipt} from '../types';
import {inspect,sendMessage} from './cliqMessenger';
import {notify} from './reminderManager';
import {queueTelegramJobs} from './telegramNotifier';

export const CUSTOM_ALARM='breakbuddy-custom';
const emptyDraft=():CustomDraft=>({text:'',url:'',name:'',minutes:30,timing:'delay',sendAt:''});
export async function readCustom():Promise<CustomData> {
  const data=await chrome.storage.local.get(['customJobs','customDraft','destinations','state']);
  if(!data.destinations && data.state?.customDestination) {
    try {data.destinations=[parseCustomDestination(data.state.customDestination.url,data.state.customDestination.name)];await chrome.storage.local.set({destinations:data.destinations});}catch{/* Invalid older custom settings must be entered again. */}
  }
  return {jobs:data.customJobs??[],draft:{...emptyDraft(),...data.customDraft},destinations:data.destinations??[]};
}
export async function saveDestination(url:string,name:string) {
  const destination=parseCustomDestination(url,name);
  const {destinations}=await readCustom();
  await chrome.storage.local.set({destinations:[...destinations.filter(d=>d.url!==destination.url),destination]});
  return destination;
}
async function storeJobs(jobs:CustomJob[]) {
  // Keep every pending job, with a bounded completed history.
  const active=jobs.filter(j=>!['sent','cancelled'].includes(j.status));
  const done=jobs.filter(j=>['sent','cancelled'].includes(j.status)).slice(0,40);
  await chrome.storage.local.set({customJobs:[...active,...done]});
  await queueTelegramJobs([...active,...done]);
  await restoreCustomAlarm([...active,...done]);
}
async function restoreCustomAlarm(jobs:CustomJob[]) {
  const deadlines=jobs.filter(j=>j.status==='scheduled').map(j=>j.scheduledAt);
  if(deadlines.length) {
    const deadline=Math.min(...deadlines);const now=Date.now();const existing=await chrome.alarms.get(CUSTOM_ALARM);
    // Read-only loads and draft saves must not keep pushing a due alarm forward.
    if(existing && (existing.scheduledTime===deadline || (deadline<=now && existing.scheduledTime>now && existing.scheduledTime<=now+1000)))return;
    await chrome.alarms.create(CUSTOM_ALARM,{when:Math.max(now+1000,deadline)});
  }
  else await chrome.alarms.clear(CUSTOM_ALARM);
}
function applyReceipt(job:CustomJob,receipt:Receipt):CustomJob {
  return {...job,status:receipt.outcome==='confirmed'?'sent':receipt.outcome==='failed'?'failed':'uncertain',detail:receipt.detail,at:receipt.at};
}
async function perform(jobs:CustomJob[],id:string) {
  const index=jobs.findIndex(j=>j.id===id);const job=jobs[index];
  const operation:Operation={id:crypto.randomUUID(),kind:'custom',text:job.text,group:'custom',destination:{...job.destination},startedAt:Date.now()};
  jobs[index]={...job,status:'sending',operation,detail:'Sending and checking delivery…'};
  await storeJobs(jobs); // Durable authorization is separate from the Break/Back operation.
  jobs[index]=applyReceipt(jobs[index],await sendMessage(operation,job.profile));
  await storeJobs(jobs);
  try {await notify(`bb-custom-${id}`,jobs[index].status==='sent'?'Scheduled message sent':'Check your scheduled message',`${job.destination.name}: ${jobs[index].status==='sent'?'Delivery confirmed.':jobs[index].detail}`);}catch{/* The persisted result remains visible in Custom Message. */}
}
export async function recoverCustom(allowSend=false,startup=false) {
  const {jobs}=await readCustom();
  let changed=false;
  for(let i=0;i<jobs.length;i++) {
    let job=jobs[i];
    if(job.status==='sending') {
      const key=`receipt:${job.operation?.id}`;const receipt=(await chrome.storage.local.get(key))[key] as Receipt|undefined;
      job=receipt?applyReceipt(job,receipt):{...job,status:'uncertain',detail:'Browser interrupted the send. Check this exact message in Cliq before resolving.'};jobs[i]=job;changed=true;
    }
    if(job.status==='scheduled' && job.scheduledAt<=Date.now()) {
      if(startup || Date.now()-job.scheduledAt>LATE_GRACE_MS) {
        jobs[i]={...job,status:'overdue',detail:'Scheduled time was missed. Choose Send now or Cancel.'};changed=true;
        try {await notify(`bb-custom-${job.id}`,'Missed scheduled message',`Open Custom Message to send or cancel your message to ${job.destination.name}.`);}catch{}
      } else if(allowSend) await perform(jobs,job.id);
    }
  }
  if(changed)await storeJobs(jobs);else await restoreCustomAlarm(jobs);
  await queueTelegramJobs(jobs);
}
export async function customCommand(command:Command,profile:Profile) {
  const data=await readCustom();
  if(command.type==='GET_CUSTOM') return data;
  if(command.type==='SAVE_CUSTOM_DRAFT') {
    const d=command.draft;
    if(typeof d.text!=='string'||d.text.length>20_000||typeof d.url!=='string'||typeof d.name!=='string'||d.url.length>2000||d.name.length>100) throw new Error('Invalid message draft.');
    await chrome.storage.local.set({customDraft:d});return {...data,draft:d};
  }
  if(command.type==='SAVE_DESTINATION') {await saveDestination(command.url,command.name);return readCustom();}
  if(command.type==='REMOVE_DESTINATION') {await chrome.storage.local.set({destinations:data.destinations.filter(d=>d.url!==command.url)});return readCustom();}
  if(command.type==='SCHEDULE_CUSTOM') {
    if(typeof command.text!=='string'||!command.text.trim()||command.text.length>20_000) throw new Error('Enter a message of 1–20,000 characters.');
    if(!Number.isSafeInteger(command.scheduledAt)||command.scheduledAt<=Date.now()||command.scheduledAt>8.64e15) throw new Error('Choose a future date and time.');
    if(data.jobs.filter(j=>!['sent','cancelled'].includes(j.status)).length>=20) throw new Error('Finish or cancel a pending message before adding more (20 maximum).');
    const destination=parseCustomDestination(command.url,command.name);
    const check=await inspect('custom',profile,true,destination);if(!check.ok)throw new Error(check.error??'Check the custom destination.');
    if(command.scheduledAt<=Date.now())throw new Error('Your selected time passed while Cliq was loading. Choose a new future time and schedule again.');
    const job:CustomJob={id:crypto.randomUUID(),text:command.text.replace(/\r\n?/g,'\n').trim(),destination,profile:{...profile},scheduledAt:command.scheduledAt,status:'scheduled',operation:null,detail:'Scheduled'};
    await saveDestination(command.url,command.name);await storeJobs([job,...data.jobs]);return readCustom();
  }
  if(command.type==='CUSTOM_ACTION') {
    const index=data.jobs.findIndex(j=>j.id===command.id);if(index<0)throw new Error('Scheduled message not found.');
    const job=data.jobs[index];
    if(command.action==='cancel') {
      if(!['scheduled','overdue','failed'].includes(job.status))throw new Error('This message cannot be cancelled during an uncertain send.');
      data.jobs[index]={...job,status:'cancelled',detail:'Cancelled without sending.'};
    } else if(command.action==='send'||command.action==='retry') {
      if(job.status!==(command.action==='send'?'overdue':'failed'))throw new Error('Check the message status before sending.');
      await perform(data.jobs,job.id);return readCustom();
    } else if(command.action==='resolve') {
      if(job.status!=='uncertain'||!job.operation||!command.checked)throw new Error('Check this exact attempt in Cliq and acknowledge the check.');
      const key=`receipt:${job.operation.id}`;const receipt=(await chrome.storage.local.get(key))[key] as Receipt|undefined;
      if(receipt?.outcome==='confirmed'||command.delivered) data.jobs[index]={...job,status:'sent',detail:'Delivery confirmed after review.',at:Date.now()};
      else {
        if(Date.now()-job.operation.startedAt<90_000)throw new Error('Wait 90 seconds after the attempt, then check Cliq again before allowing a retry.');
        data.jobs[index]={...job,status:'failed',detail:'You confirmed the message is absent. Remove any leftover draft before retrying.'};
      }
    }
    await storeJobs(data.jobs);return readCustom();
  }
  throw new Error('Unknown custom message command.');
}
