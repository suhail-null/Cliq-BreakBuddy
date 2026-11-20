import {destinationFor} from '../config';
import type {CustomJob, Destination, State, TelegramSettings} from '../types';
import {TelegramError,telegramRequest} from './telegramApi';

export interface TelegramAction {kind:'back'|'snooze'|'cancel-break'|'cancel-custom';reference:string;jobId?:string;}
interface Button {token:string;label:string;action:TelegramAction;used?:boolean;}
export interface Config {enabled:boolean; botToken:string; chatId:string; enabledAt:number;controllerId:string;}
export interface Report {id:string; text:string; status:'pending'|'sent'|'failed'; attempts:number; nextAt:number;buttons?:Button[];messageIds?:number[];}
type Outcome='scheduled'|'rescheduled'|'cancelled'|'back-pending'|'snoozed'|'confirmed'|'failed'|'uncertain'|'overdue';
const emptyConfig=():Config=>({enabled:false,botToken:'',chatId:'',enabledAt:0,controllerId:''});
const MAX_ATTEMPTS=5;

export async function readTelegramData() {
  const data=await chrome.storage.local.get(['telegramConfig','telegramReports','telegramLastReport','telegramLastAction','telegramActionsError']);
  return {config:{...emptyConfig(),...data.telegramConfig} as Config,reports:(data.telegramReports??[]) as Report[],lastReport:(data.telegramLastReport??null) as TelegramSettings['lastReport'],
    lastAction:(data.telegramLastAction??null) as TelegramSettings['lastAction'],actionsError:(data.telegramActionsError??null) as string|null};
}
const read=readTelegramData;
export const controllerFor=(config:Config)=>config.controllerId||(/^[1-9]\d*$/.test(config.chatId)?config.chatId:'');
export const breakCycleReference=(state:State)=>state.history.find(h=>h.text==='Break')?.id??String(state.breakSentAt??'');
export async function getTelegramSettings():Promise<TelegramSettings> {
  const {config,reports,lastReport,lastAction,actionsError}=await read();
  return {enabled:config.enabled,chatId:config.chatId,hasToken:Boolean(config.botToken),controllerId:config.controllerId,actionsAvailable:config.enabled&&Boolean(controllerFor(config)),actionsError,lastAction,lastReport,pending:reports.filter(r=>r.status==='pending').length};
}
export async function saveTelegramSettings(enabled:boolean,botToken:string,chatId:string,controllerId?:string) {
  if(typeof enabled!=='boolean'||typeof botToken!=='string'||typeof chatId!=='string')throw new Error('Invalid Telegram settings.');
  const {config}=await read();
  const token=botToken.trim()||config.botToken;
  const chat=chatId.trim();
  if(controllerId!==undefined&&typeof controllerId!=='string')throw new Error('Enter a numeric Telegram user ID for buttons.');
  const controller=controllerId===undefined?config.controllerId:controllerId.trim();
  if(controller&&!/^[1-9]\d{0,19}$/.test(controller))throw new Error('Enter a numeric Telegram user ID for buttons.');
  if(token&&!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))throw new Error('Paste the bot token from BotFather.');
  if(chat&&!/^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chat))throw new Error('Enter a numeric Telegram chat ID or an @channel username.');
  if(enabled&&(!token||!chat))throw new Error('Enter a bot token and chat ID before enabling Telegram reports.');
  const changed=config.botToken!==token||config.chatId!==chat||config.enabled!==enabled||config.controllerId!==controller;
  await chrome.storage.local.set({telegramConfig:{enabled,botToken:token,chatId:chat,controllerId:controller,enabledAt:changed?Date.now():config.enabledAt},
    ...(changed?{telegramReports:[],telegramLastReport:null,telegramLastAction:null,telegramActionsError:null,telegramActionPoll:{},telegramBreakSchedule:null,telegramCustomSchedules:{}}:{})});
  return getTelegramSettings();
}
export async function disconnectTelegram() {
  await chrome.storage.local.set({telegramConfig:emptyConfig(),telegramReports:[],telegramLastReport:null,telegramLastAction:null,telegramActionsError:null,telegramActionPoll:{},telegramBreakSchedule:null,telegramCustomSchedules:{}});
  return getTelegramSettings();
}

const send=(config:Config,text:string,buttons?:Button[])=>telegramRequest(config.botToken,'sendMessage',{chat_id:config.chatId,text,link_preview_options:{is_disabled:true},
  ...(buttons?.length?{reply_markup:{inline_keyboard:buttons.map(button=>[{text:button.label,callback_data:`bb:${button.token}`}])}}:{})});
export async function findTelegramChats(botToken:string):Promise<{id:string;name:string}[]> {
  if(typeof botToken!=='string')throw new Error('Invalid bot token.');
  const {config}=await read();const token=botToken.trim()||config.botToken;
  if(!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))throw new Error('Paste the bot token from BotFather first.');
  // No offset: this setup read does not acknowledge or consume updates.
  const updates=await telegramRequest(token,'getUpdates',{timeout:0,limit:100,allowed_updates:['message','channel_post','my_chat_member','callback_query']});
  const chats=new Map<string,{id:string;name:string}>();
  if(Array.isArray(updates))for(const update of updates) {
    const chat=update.message?.chat??update.channel_post?.chat??update.my_chat_member?.chat;
    if(chat&&Number.isSafeInteger(chat.id))chats.set(String(chat.id),{id:String(chat.id),name:String(chat.title||[chat.first_name,chat.last_name].filter(Boolean).join(' ')||chat.id)});
  }
  if(!chats.size)throw new Error('No chats found. Open your bot in Telegram, send /start (or a command addressed to it in your group), then find chats again.');
  return [...chats.values()];
}
async function recordResult(ok:boolean,detail:string) {
  await chrome.storage.local.set({telegramLastReport:{ok,detail,at:Date.now()}});
}
export async function testTelegram() {
  const {config}=await read();
  if(!config.botToken||!config.chatId)throw new Error('Save your Telegram bot token and chat ID first.');
  try {await send(config,'BreakBuddy test: Telegram reports are connected. You will receive Cliq delivery results here when reports are enabled.');}
  catch(error){await recordResult(false,(error as Error).message);throw error;}
  await recordResult(true,'Telegram test sent successfully.');
  return getTelegramSettings();
}

const localTime=(at:number)=>new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'});
function message(outcome:Outcome,text:string,destination:Destination|undefined,detail:string,at:number,manual=false,subject='Break') {
  const title={scheduled:`${subject} scheduled`,rescheduled:`${subject} rescheduled`,cancelled:`${subject} schedule cancelled`,'back-pending':'Back is still pending',snoozed:'Back reminder snoozed',confirmed:'Message successfully sent',failed:'Message was not sent',uncertain:'Delivery uncertain — check Cliq',overdue:'Scheduled message was missed — not sent'}[outcome];
  const time=['scheduled','rescheduled'].includes(outcome)?`Scheduled for: ${localTime(at)}`:`Time: ${new Date(at).toISOString()}`;
  return [`BreakBuddy: ${title}`,`Chat: ${destination?.name??'Saved Cliq destination'}`,`Message: ${text.length>200?text.slice(0,200)+'…':text}`,
    time,manual?'Confirmed by your manual review.':outcome==='confirmed'?'Confirmed by Cliq UI verification.':detail.slice(0,400),
    ...(outcome==='uncertain'?['Check this exact attempt in Cliq before retrying.']:[])].join('\n');
}
type ButtonSpec={label:string;action:TelegramAction};
async function enqueue(id:string,outcome:Outcome,text:string,destination:Destination|undefined,detail:string,at:number,manual=false,buttons:ButtonSpec[]=[],subject='Break') {
  const {config,reports}=await read();
  if(!config.enabled||at<config.enabledAt||reports.some(r=>r.id===id))return;
  const report:Report={id,text:message(outcome,text,destination,detail,at,manual,subject),status:'pending',attempts:0,nextAt:0,
    ...(controllerFor(config)&&buttons.length?{buttons:buttons.map(button=>({...button,token:crypto.randomUUID().replaceAll('-','')}))}:{})};
  // Current Cliq histories are bounded to 40 entries each. Keep enough IDs to suppress repeats.
  await chrome.storage.local.set({telegramReports:[...reports,report].slice(-300)});
}
export async function queueTelegramState(state:State) {
  try {
    if(!(await read()).config.enabled)return;
    const data=await chrome.storage.local.get(['telegramBreakSchedule']);
    const previous=data.telegramBreakSchedule as {scheduledAt:number;destination:Destination;active:boolean}|undefined;
    if(['BREAK_SCHEDULED','OVERDUE'].includes(state.status)&&state.scheduledAt) {
      const destination=destinationFor(state.group,state.customDestination);
      const buttons:ButtonSpec[]=[{label:'Cancel schedule',action:{kind:'cancel-break',reference:String(state.scheduledAt)}}];
      if(previous?.active&&previous.scheduledAt!==state.scheduledAt)await enqueue(`break:${previous.scheduledAt}:${state.scheduledAt}:rescheduled`,'rescheduled','Break',destination,`Previous time: ${localTime(previous.scheduledAt)}`,state.scheduledAt,false,buttons);
      else if(state.status==='BREAK_SCHEDULED'&&!previous?.active)await enqueue(`break:${state.scheduledAt}:scheduled`,'scheduled','Break',destination,'You will receive a separate report when the send is attempted.',state.scheduledAt,false,buttons);
      await chrome.storage.local.set({telegramBreakSchedule:{scheduledAt:state.scheduledAt,destination,active:true}});
    } else if(previous?.active) {
      if(state.status==='AVAILABLE')await enqueue(`break:${previous.scheduledAt}:cancelled`,'cancelled','Break',previous.destination,'No further send will be attempted for this schedule.',Date.now());
      await chrome.storage.local.set({telegramBreakSchedule:{...previous,active:false}});
    }
    const cycle=breakCycleReference(state);
    const backButtons:ButtonSpec[]=state.backPending&&['BACK_PENDING','ERROR'].includes(state.status)?[
      {label:"I'm Back — Send Back",action:{kind:'back',reference:cycle}},
      {label:'Remind in 5 minutes',action:{kind:'snooze',reference:cycle}},
    ]:[];
    for(const entry of [...state.history].reverse())await enqueue(`${entry.id}:confirmed`,'confirmed',entry.text,entry.destination,'',entry.at,entry.proof==='manual',entry.id===cycle?backButtons:[]);
    const op=state.operation;
    if(op&&(state.status==='ERROR'||state.status==='UNCERTAIN')) {
      const outcome=state.status==='ERROR'?'failed':'uncertain';
      await enqueue(`${op.id}:${outcome}`,outcome,op.text,op.destination,state.error??'',op.startedAt);
    }
    if(state.status==='OVERDUE'&&state.scheduledAt)await enqueue(`break:${state.scheduledAt}:overdue`,'overdue','Break',destinationFor(state.group,state.customDestination),state.error??'',state.scheduledAt);
    if(state.backPending&&state.lastReminderAt&&state.lastReminderAt-(state.breakSentAt??state.lastReminderAt)>=60_000)await enqueue(`${cycle}:${state.lastReminderAt}:back-pending`,'back-pending','Back',destinationFor(state.group,state.customDestination),state.status==='UNCERTAIN'?'Check the uncertain attempt in BreakBuddy before sending again.':'Confirm your return when you are ready. Back is never sent automatically.',state.lastReminderAt,false,backButtons);
    if(state.backPending&&state.snoozeUntil&&state.snoozeUntil>Date.now())await enqueue(`${cycle}:${state.snoozeUntil}:snoozed`,'snoozed','Back',destinationFor(state.group,state.customDestination),`Next reminder: ${localTime(state.snoozeUntil)}`,state.snoozeUntil-5*60_000,false,backButtons);
  } catch {console.warn('BreakBuddy: Could not queue a Telegram report.');}
}
export async function queueTelegramJobs(jobs:CustomJob[]) {
  try {
    if(!(await read()).config.enabled)return;
    const {telegramCustomSchedules:previous={}}=await chrome.storage.local.get(['telegramCustomSchedules']);
    const schedules:Record<string,number>={};
    for(const job of jobs) {
      if(job.status==='scheduled') {
        schedules[job.id]=job.scheduledAt;
        const changed=previous[job.id]&&previous[job.id]!==job.scheduledAt;
        if(!previous[job.id]||changed)await enqueue(`custom:${job.id}:${job.scheduledAt}:${changed?'rescheduled':'scheduled'}`,changed?'rescheduled':'scheduled',job.text,job.destination,changed?`Previous time: ${localTime(previous[job.id])}`:'You will receive a separate report when the send is attempted.',job.scheduledAt,false,
          [{label:'Cancel schedule',action:{kind:'cancel-custom',jobId:job.id,reference:String(job.scheduledAt)}}],'Custom message');
        continue;
      }
      if(job.status==='cancelled') {
        if(job.at)await enqueue(`custom:${job.id}:cancelled`,'cancelled',job.text,job.destination,'No further send will be attempted for this schedule.',job.at,false,[],'Custom message');
        continue;
      }
      if(!['sent','failed','uncertain','overdue'].includes(job.status))continue;
      const outcome:Outcome=job.status==='sent'?'confirmed':job.status as Outcome;
      await enqueue(`${job.operation?.id??job.id}:${outcome}`,outcome,job.text,job.destination,job.detail,job.at??job.operation?.startedAt??job.scheduledAt,
        job.status==='sent'&&job.detail==='Delivery confirmed after review.');
    }
    await chrome.storage.local.set({telegramCustomSchedules:schedules});
  } catch {console.warn('BreakBuddy: Could not queue a Telegram report.');}
}
export async function flushTelegramReports() {
  try {
    const {config,reports}=await read();
    if(!config.enabled)return;
    // A retry deadline also applies to other reports for this bot/chat, especially after a 429.
    if(reports.some(r=>r.status!=='sent'&&r.nextAt>Date.now()))return;
    // Bound worker time. The existing one-minute recovery alarm flushes remaining reports.
    for(const report of reports.filter(r=>r.status==='pending'&&r.nextAt<=Date.now()).slice(0,3)) {
      report.attempts++;
      report.nextAt=Date.now()+60_000;
      await chrome.storage.local.set({telegramReports:reports});
      try {
        const result=await send(config,report.text,report.buttons);
        if(Number.isSafeInteger(result?.message_id))report.messageIds=[...(report.messageIds??[]),result.message_id].slice(-MAX_ATTEMPTS);
        report.status='sent';await recordResult(true,'Telegram report sent.');
      }
      catch(error) {
        const failure=error as TelegramError;
        report.status=failure.retryable&&report.attempts<MAX_ATTEMPTS?'pending':'failed';
        report.nextAt=Date.now()+Math.max(failure.retryAfter,60_000*report.attempts);
        await recordResult(false,`${failure.message}${report.status==='pending'?' A retry is queued.':' Save corrected settings to reconnect.'}`);
        await chrome.storage.local.set({telegramReports:reports});
        break;
      }
      await chrome.storage.local.set({telegramReports:reports});
    }
  } catch {console.warn('BreakBuddy: Telegram reporting is unavailable.');}
}
export async function queueTelegramActionFeedback(id:string,detail:string) {
  const {config,reports}=await read();
  if(!config.enabled||reports.some(r=>r.id===id))return;
  await chrome.storage.local.set({telegramReports:[...reports,{id,text:`BreakBuddy: ${detail}`,status:'pending',attempts:0,nextAt:0}].slice(-300)});
}
