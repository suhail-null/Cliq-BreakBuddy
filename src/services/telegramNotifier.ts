import {destinationFor} from '../config';
import type {CustomJob, Destination, State, TelegramSettings} from '../types';

interface Config {enabled:boolean; botToken:string; chatId:string; enabledAt:number;}
interface Report {id:string; text:string; status:'pending'|'sent'|'failed'; attempts:number; nextAt:number;}
type Outcome='scheduled'|'confirmed'|'failed'|'uncertain'|'overdue';
const emptyConfig=():Config=>({enabled:false,botToken:'',chatId:'',enabledAt:0});
const MAX_ATTEMPTS=5;

async function read() {
  const data=await chrome.storage.local.get(['telegramConfig','telegramReports','telegramLastReport']);
  return {config:{...emptyConfig(),...data.telegramConfig} as Config,reports:(data.telegramReports??[]) as Report[],lastReport:(data.telegramLastReport??null) as TelegramSettings['lastReport']};
}
export async function getTelegramSettings():Promise<TelegramSettings> {
  const {config,reports,lastReport}=await read();
  return {enabled:config.enabled,chatId:config.chatId,hasToken:Boolean(config.botToken),lastReport,pending:reports.filter(r=>r.status==='pending').length};
}
export async function saveTelegramSettings(enabled:boolean,botToken:string,chatId:string) {
  if(typeof enabled!=='boolean'||typeof botToken!=='string'||typeof chatId!=='string')throw new Error('Invalid Telegram settings.');
  const {config}=await read();
  const token=botToken.trim()||config.botToken;
  const chat=chatId.trim();
  if(token&&!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))throw new Error('Paste the bot token from BotFather.');
  if(chat&&!/^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chat))throw new Error('Enter a numeric Telegram chat ID or an @channel username.');
  if(enabled&&(!token||!chat))throw new Error('Enter a bot token and chat ID before enabling Telegram reports.');
  const changed=config.botToken!==token||config.chatId!==chat||config.enabled!==enabled;
  await chrome.storage.local.set({telegramConfig:{enabled,botToken:token,chatId:chat,enabledAt:changed?Date.now():config.enabledAt},
    ...(changed?{telegramReports:[],telegramLastReport:null}:{})});
  return getTelegramSettings();
}
export async function disconnectTelegram() {
  await chrome.storage.local.set({telegramConfig:emptyConfig(),telegramReports:[],telegramLastReport:null});
  return getTelegramSettings();
}

class TelegramError extends Error {
  constructor(message:string,readonly retryable=false,readonly retryAfter=60_000){super(message);}
}
async function telegramRequest(botToken:string,method:'sendMessage'|'getUpdates',body:Record<string,unknown>) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(`https://api.telegram.org/bot${botToken}/${method}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),
      signal:controller.signal,credentials:'omit',redirect:'error',
    });
    let data:any;
    try {data=await response.json();}catch {throw new TelegramError('Telegram returned an unreadable response.',true);}
    if(!response.ok||data?.ok!==true) {
      const code=data?.error_code??response.status;
      if(code===429)throw new TelegramError('Telegram rate limit reached. The report will be retried.',true,Math.min(86400,Math.max(60,Number(data?.parameters?.retry_after)||60))*1000);
      if(code===401||code===404)throw new TelegramError('Telegram rejected the bot token. Check the token from BotFather.');
      if(code===403)throw new TelegramError('Telegram blocked this report. Start the bot or give it permission to post in the target chat.');
      if(code===409)throw new TelegramError('This bot uses a webhook or another update reader. Use a dedicated bot or enter the chat ID manually.');
      if(code===400)throw new TelegramError('Telegram could not send to this chat. Check the chat ID, start the bot, and check its posting permissions.');
      throw new TelegramError('Telegram could not accept the report.',code>=500);
    }
    return data.result;
  } catch(error) {
    if(error instanceof TelegramError)throw error;
    // Fetch errors may contain the request URL (and therefore the token).
    throw new TelegramError('Telegram is unreachable or timed out. Check your connection.',true);
  } finally {clearTimeout(timeout);}
}
const send=(config:Config,text:string)=>telegramRequest(config.botToken,'sendMessage',{chat_id:config.chatId,text,link_preview_options:{is_disabled:true}});
export async function findTelegramChats(botToken:string):Promise<{id:string;name:string}[]> {
  if(typeof botToken!=='string')throw new Error('Invalid bot token.');
  const {config}=await read();const token=botToken.trim()||config.botToken;
  if(!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))throw new Error('Paste the bot token from BotFather first.');
  // No offset: this setup read does not acknowledge or consume updates.
  const updates=await telegramRequest(token,'getUpdates',{timeout:0,limit:100});
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

function message(outcome:Outcome,text:string,destination:Destination|undefined,detail:string,at:number,manual=false) {
  const title={scheduled:'Break scheduled',confirmed:'Message successfully sent',failed:'Message was not sent',uncertain:'Delivery uncertain — check Cliq',overdue:'Scheduled message was missed — not sent'}[outcome];
  const time=outcome==='scheduled'?`Scheduled for: ${new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})}`:`Time: ${new Date(at).toISOString()}`;
  return [`BreakBuddy: ${title}`,`Chat: ${destination?.name??'Saved Cliq destination'}`,`Message: ${text.length>200?text.slice(0,200)+'…':text}`,
    time,manual?'Confirmed by your manual review.':outcome==='confirmed'?'Confirmed by Cliq UI verification.':detail.slice(0,400),
    ...(outcome==='uncertain'?['Check this exact attempt in Cliq before retrying.']:[])].join('\n');
}
async function enqueue(id:string,outcome:Outcome,text:string,destination:Destination|undefined,detail:string,at:number,manual=false) {
  const {config,reports}=await read();
  if(!config.enabled||at<config.enabledAt||reports.some(r=>r.id===id))return;
  const report:Report={id,text:message(outcome,text,destination,detail,at,manual),status:'pending',attempts:0,nextAt:0};
  // Current Cliq histories are bounded to 40 entries each. Keep enough IDs to suppress repeats.
  await chrome.storage.local.set({telegramReports:[...reports,report].slice(-300)});
}
export async function queueTelegramState(state:State) {
  try {
    if(!(await read()).config.enabled)return;
    if(state.status==='BREAK_SCHEDULED'&&state.scheduledAt)await enqueue(`break:${state.scheduledAt}:scheduled`,'scheduled','Break',destinationFor(state.group,state.customDestination),'You will receive a separate report when the send is attempted.',state.scheduledAt);
    for(const entry of [...state.history].reverse())await enqueue(`${entry.id}:confirmed`,'confirmed',entry.text,entry.destination,'',entry.at,entry.proof==='manual');
    const op=state.operation;
    if(op&&(state.status==='ERROR'||state.status==='UNCERTAIN')) {
      const outcome=state.status==='ERROR'?'failed':'uncertain';
      await enqueue(`${op.id}:${outcome}`,outcome,op.text,op.destination,state.error??'',op.startedAt);
    }
    if(state.status==='OVERDUE'&&state.scheduledAt)await enqueue(`break:${state.scheduledAt}:overdue`,'overdue','Break',destinationFor(state.group,state.customDestination),state.error??'',state.scheduledAt);
  } catch {console.warn('BreakBuddy: Could not queue a Telegram report.');}
}
export async function queueTelegramJobs(jobs:CustomJob[]) {
  try {
    if(!(await read()).config.enabled)return;
    for(const job of jobs) {
      if(!['sent','failed','uncertain','overdue'].includes(job.status))continue;
      const outcome:Outcome=job.status==='sent'?'confirmed':job.status as Outcome;
      await enqueue(`${job.operation?.id??job.id}:${outcome}`,outcome,job.text,job.destination,job.detail,job.at??job.operation?.startedAt??job.scheduledAt,
        job.status==='sent'&&job.detail==='Delivery confirmed after review.');
    }
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
      try {await send(config,report.text);report.status='sent';await recordResult(true,'Telegram delivery report sent.');}
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
