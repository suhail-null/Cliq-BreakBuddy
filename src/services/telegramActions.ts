import type {Command,CustomJob,State} from '../types';
import {telegramRequest,TelegramError} from './telegramApi';
import {breakCycleReference,controllerFor,queueTelegramActionFeedback,readTelegramData,type Config,type TelegramAction} from './telegramNotifier';

export const TELEGRAM_POLL_ALARM='breakbuddy-telegram-actions';
interface Batch {config:Config;updates:any[];}
const generation=(config:Config)=>`${config.enabledAt}:${config.botToken.split(':')[0]}:${config.chatId}:${config.controllerId}`;
const pollFor=(config:Config,poll:any)=>poll?.generation===generation(config)?poll:{};
export async function restoreTelegramPolling() {
  const {config}=await readTelegramData();
  if(!config.enabled||!controllerFor(config)){await chrome.alarms.clear(TELEGRAM_POLL_ALARM);return;}
  if(!(await chrome.alarms.get(TELEGRAM_POLL_ALARM)))await chrome.alarms.create(TELEGRAM_POLL_ALARM,{periodInMinutes:0.5});
}
// Fetch outside the Cliq action queue: long polling must not delay a due send.
export async function fetchTelegramActions():Promise<Batch|null> {
  const {config}=await readTelegramData();
  if(!config.enabled||!controllerFor(config))return null;
  const stored=await chrome.storage.local.get(['telegramActionPoll']);const poll=pollFor(config,stored.telegramActionPoll);
  if(poll.nextAt>Date.now())return null;
  await chrome.storage.local.set({telegramActionPoll:{...poll,generation:generation(config),nextAt:Date.now()+30_000}});
  try {
    const updates=await telegramRequest(config.botToken,'getUpdates',{timeout:20,limit:25,
      allowed_updates:['message','channel_post','my_chat_member','callback_query'],
      ...(Number.isSafeInteger(poll.offset)?{offset:poll.offset}:{}),
    });
    if(!Array.isArray(updates))throw new TelegramError('Telegram returned an unreadable update list.',true);
    return {config,updates};
  } catch(error) {
    // Ignore a response from a bot that was disconnected/replaced during the request.
    const current=(await readTelegramData()).config;
    if(current.botToken===config.botToken&&current.enabledAt===config.enabledAt) {
      const stored=await chrome.storage.local.get(['telegramActionPoll']);const latest=pollFor(config,stored.telegramActionPoll);
      await chrome.storage.local.set({telegramActionsError:(error as Error).message,
        telegramActionPoll:{...latest,generation:generation(config),nextAt:Date.now()+Math.max(60_000,(error as TelegramError).retryAfter??0)}});
    }
    return null;
  }
}
function matchesChat(config:Config,chat:any) {
  if(!chat)return false;
  return config.chatId.startsWith('@')?typeof chat.username==='string'&&`@${chat.username}`.toLowerCase()===config.chatId.toLowerCase():String(chat.id)===config.chatId;
}
async function answer(token:string,queryId:string,text:string) {
  // A callback may have expired while Chrome was asleep; the guarded action still gets a report.
  try {await telegramRequest(token,'answerCallbackQuery',{callback_query_id:queryId,text:text.slice(0,190)});}catch{/* Keep action validation independent of the Telegram spinner. */}
}
export async function processTelegramActions(batch:Batch,execute:(action:TelegramAction)=>Promise<string>) {
  let current=await readTelegramData();
  if(!current.config.enabled||current.config.botToken!==batch.config.botToken||current.config.enabledAt!==batch.config.enabledAt||current.config.controllerId!==batch.config.controllerId||current.config.chatId!==batch.config.chatId)return;
  await chrome.storage.local.set({telegramActionsError:null});
  for(const update of batch.updates.filter(update=>update&&Number.isSafeInteger(update.update_id)).sort((a,b)=>a.update_id-b.update_id)) {
    if(!Number.isSafeInteger(update.update_id)||update.update_id<0)continue;
    const stored=await chrome.storage.local.get(['telegramActionPoll']);const poll=pollFor(batch.config,stored.telegramActionPoll);
    if(Number.isSafeInteger(poll.offset)&&update.update_id<poll.offset)continue;
    // Commit before authorizing a Cliq operation so a replay cannot submit again.
    await chrome.storage.local.set({telegramActionPoll:{...poll,generation:generation(batch.config),offset:update.update_id+1}});
    const query=update.callback_query;
    if(!query||typeof query.id!=='string')continue;
    current=await readTelegramData();
    const {config,reports}=current;
    if(!matchesChat(config,query.message?.chat)||String(query.from?.id)!==controllerFor(config)||query.from?.is_bot||query.message?.date===0) {
      await answer(config.botToken,query.id,'This action is not available for this user or chat.');continue;
    }
    const token=typeof query.data==='string'&&/^bb:[a-f0-9]{32}$/.test(query.data)?query.data.slice(3):'';
    const report=reports.find(r=>r.buttons?.some(b=>b.token===token));
    const button=report?.buttons?.find(b=>b.token===token);
    if(!report||!button||button.used||!report.messageIds?.includes(query.message.message_id)) {
      await answer(config.botToken,query.id,'This button was already used or is no longer available.');continue;
    }
    for(const entry of report.buttons??[])entry.used=true;
    await chrome.storage.local.set({telegramReports:reports,telegramLastAction:{ok:true,detail:'Processing Telegram action…',at:Date.now()}});
    await answer(config.botToken,query.id,'Processing your request. Check the follow-up report.');
    let ok=true;let detail:string;
    try {detail=await execute(button.action);}
    catch(error){ok=false;detail=`Action not applied: ${(error instanceof Error?error.message:String(error)).replaceAll(config.botToken,'[hidden]').slice(0,350)}`;}
    await chrome.storage.local.set({telegramLastAction:{ok,detail,at:Date.now()}});
    if(!ok)await queueTelegramActionFeedback(`action:${token}:rejected`,detail);
    try {await telegramRequest(config.botToken,'editMessageReplyMarkup',{chat_id:query.message.chat.id,message_id:query.message.message_id,reply_markup:{inline_keyboard:[]}});}catch{/* State and consumed tokens remain authoritative. */}
  }
}
export function commandForTelegramAction(action:TelegramAction,state:State,jobs:CustomJob[]):Command {
  if(action.kind==='back'||action.kind==='snooze') {
    if(!state.backPending||action.reference!==breakCycleReference(state))throw new Error('This Break/Back cycle has ended. Use the latest Telegram reminder.');
    if(!['BACK_PENDING','ERROR'].includes(state.status))throw new Error('Resolve the current message attempt in BreakBuddy before using this button.');
    return {type:action.kind==='back'?'BACK':'SNOOZE'};
  }
  if(action.kind==='cancel-break') {
    if(!['BREAK_SCHEDULED','OVERDUE'].includes(state.status)||String(state.scheduledAt)!==action.reference)throw new Error('This Break schedule has changed or already started.');
    return {type:'CANCEL'};
  }
  if(action.kind==='cancel-custom') {
    const job=jobs.find(j=>j.id===action.jobId);
    if(!job||!['scheduled','overdue'].includes(job.status)||String(job.scheduledAt)!==action.reference)throw new Error('This custom schedule has changed or already started.');
    return {type:'CUSTOM_ACTION',id:job.id,action:'cancel'};
  }
  throw new Error('Unknown Telegram action.');
}
