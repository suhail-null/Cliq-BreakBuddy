import { BREAK_ALARM, REMINDER_ALARM, destinationFor, parseCustomDestination } from '../config';
import { readState, writeState } from '../services/storageManager';
import { dueDecision, restoreAlarms, validMinutes } from '../services/breakScheduler';
import { findTab, inspect, sendMessage } from '../services/cliqMessenger';
import { closeReminder, notify, reminderWindow, updateBadge } from '../services/reminderManager';
import { complete } from './machine';
import {recordPanelVisibility,registerPanelAction} from '../services/panelManager';
import {customCommand,readCustom,recoverCustom,saveDestination} from '../services/customMessages';
import {disconnectTelegram,findTelegramChats,flushTelegramReports,getTelegramSettings,queueTelegramState,saveTelegramSettings,testTelegram} from '../services/telegramNotifier';
import {commandForTelegramAction,fetchTelegramActions,processTelegramActions,restoreTelegramPolling,TELEGRAM_POLL_ALARM} from '../services/telegramActions';
import type { Command, Operation, Receipt, State } from '../types';

// All event sources share one queue; a persisted operation prevents replay across worker restarts.
let queue: Promise<unknown> = Promise.resolve();
let telegramPoll:Promise<void>|null=null;
let telegramPollRequest:ReturnType<typeof fetchTelegramActions>|null=null;
function serial<T>(task:()=>Promise<T>): Promise<T> { const result = queue.then(async()=>{try{return await task();}finally{await flushTelegramReports();await auxiliary(restoreTelegramPolling);}}); queue = result.catch(()=>{}); return result; }
async function save(s: State) { await writeState(s); await queueTelegramState(s); await updateBadge(s); }
async function auxiliary(task:()=>Promise<unknown>) { try {await task();} catch(error) {console.warn('BreakBuddy reminder:', error);} }
async function remind(s: State, force = false) {
  if (!s.backPending || s.status === 'SENDING_BACK' || (s.snoozeUntil ?? 0) > Date.now()) return;
  if (!force && Date.now() - (s.lastReminderAt ?? 0) < 5*60_000) return;
  s.lastReminderAt = Date.now(); await save(s);
  if(s.status==='UNCERTAIN') await auxiliary(()=>notify('bb-error','Check your Back message','A submission is uncertain. Open BreakBuddy to check and resolve it.',['Open BreakBuddy']));
  else await auxiliary(()=>notify('bb-back', 'Have you returned?', 'Your Break message was sent. Confirm your return to send Back.', ["I'm Back — Send Back",'Remind Me Later']));
  if (await chrome.idle.queryState(60) === 'active') await auxiliary(reminderWindow);
}
async function perform(s: State, text: 'Break'|'Back') {
  if (s.group !== 'test' && !s.productionEnabled) throw new Error('Production mode requires explicit confirmation in Settings.');
  if (text === 'Back' && !s.backPending) throw new Error('There is no Back message pending.');
  const op: Operation = {id:crypto.randomUUID(),text,group:s.group,destination:destinationFor(s.group,s.customDestination),startedAt:Date.now()};
  s = {...s,operation:op,status:text==='Break'?'SENDING_BREAK':'SENDING_BACK',submission:'sending',error:null};
  await save(s); // Commit before any DOM interaction.
  const result = await sendMessage(op,s.profile);
  s = complete(s,op,result); await save(s); await restoreAlarms(s);
  if (result.outcome === 'confirmed') {
    if (text === 'Break') await remind(s,true);
    else { await auxiliary(closeReminder); await auxiliary(()=>notify('bb-sent','You’re available',`Back confirmed in ${destinationFor(s.group,s.customDestination).name}.`)); }
  } else await auxiliary(()=>notify('bb-error',result.outcome === 'uncertain'?'Check your chat before retrying':'Message was not sent',result.detail,['Open BreakBuddy']));
  return s;
}
async function recover(allowDueSend = true, startup = false) {
  let s = await readState();
  if (s.status === 'SENDING_BREAK' || s.status === 'SENDING_BACK') {
    const op = s.operation;
    const receipt = op ? (await chrome.storage.local.get(`receipt:${op.id}`))[`receipt:${op.id}`] as Receipt | undefined : undefined;
    if (op && receipt) s = complete(s,op,receipt);
    else s = {...s,status:'UNCERTAIN',submission:'uncertain',error:'Chrome interrupted a send. Check the destination chat before resolving this attempt.'};
    await save(s);
  }
  const due = dueDecision(s,Date.now());
  if (due === 'overdue' || (startup && due === 'send')) {
    s = {...s,status:'OVERDUE',error:'Your scheduled Break was missed. Choose Send now or Cancel.'}; await save(s);
    await auxiliary(()=>notify('bb-overdue','Missed scheduled Break','Chrome or the device was unavailable. Send the Break now?',['Send now','Cancel']));
  } else if (due === 'send' && allowDueSend) s = await perform(s,'Break');
  await updateBadge(s); await restoreAlarms(s); await remind(s,startup);
  await recoverCustom(allowDueSend,startup);
  await queueTelegramState(s); // Recover reports if the worker stopped after persisting the Cliq result.
  return s;
}
async function handle(command: Command) {
  // GET also reconciles startup state, without performing a scheduled send.
  let s = await recover(false);
  if(['GET_CUSTOM','SAVE_CUSTOM_DRAFT','SCHEDULE_CUSTOM','CUSTOM_ACTION','SAVE_DESTINATION','REMOVE_DESTINATION'].includes(command.type)) return customCommand(command,s.profile);
  switch(command.type) {
    case 'GET_TELEGRAM': return getTelegramSettings();
    case 'SAVE_TELEGRAM': return saveTelegramSettings(command.enabled,command.botToken,command.chatId,command.controllerId);
    case 'TEST_TELEGRAM': return testTelegram();
    case 'DISCONNECT_TELEGRAM': return disconnectTelegram();
    case 'FIND_TELEGRAM_CHATS':
      // Chat discovery and the action reader must not compete for the same bot's updates.
      if(telegramPollRequest)await telegramPollRequest;
      return findTelegramChats(command.botToken);
    case 'GET': return s;
    case 'SCHEDULE':
      if (s.status !== 'AVAILABLE') throw new Error('Finish or cancel the current break first.');
      if(s.group!=='test' && !s.productionEnabled) throw new Error('Enable your Break/Back destination in Settings first.');
      if (!validMinutes(command.minutes)) throw new Error('Enter a positive whole number of minutes that fits a valid future date.');
      if (Object.values(s.profile).some(v=>!v.trim())) throw new Error('Complete and check the Cliq selector setup in Settings first.');
      {const check = await inspect(s.group,s.profile,true,s.customDestination); if (!check.ok) throw new Error(check.error ?? 'Setup check failed.');}
      s = {...s,status:'BREAK_SCHEDULED',scheduledAt:Date.now()+command.minutes*60_000,submission:'none',error:null,operation:null};
      await save(s); await restoreAlarms(s); return s;
    case 'CANCEL':
      if (!['BREAK_SCHEDULED','OVERDUE'].includes(s.status) && !(s.status==='ERROR' && !s.backPending)) throw new Error('This send cannot be cancelled.');
      s = {...s,status:'AVAILABLE',scheduledAt:null,error:null,operation:null,submission:'none'};
      await save(s); await chrome.alarms.clear(BREAK_ALARM); await chrome.notifications.clear('bb-overdue'); return s;
    case 'SEND_NOW':
      if (s.status !== 'OVERDUE') throw new Error('No missed Break is waiting.');
      await chrome.notifications.clear('bb-overdue'); return perform(s,'Break');
    case 'BACK':
      if (s.status !== 'BACK_PENDING' && !(s.status==='ERROR' && s.backPending)) throw new Error('Resolve the current message attempt first.');
      return perform(s,'Back');
    case 'RETRY':
      if (s.status !== 'ERROR' || !s.operation) throw new Error('Only a definite failed send can be retried.');
      if(s.operation.text!=='Break' && s.operation.text!=='Back') throw new Error('Unsupported break operation.');
      return perform(s,s.operation.text);
    case 'RESOLVE': {
      if (s.status !== 'UNCERTAIN' || !s.operation || !command.checked) throw new Error('Check the exact message in Cliq and acknowledge that check first.');
      // A late content-script receipt takes precedence over manual "not delivered".
      const key = `receipt:${s.operation.id}`;
      const receipt = (await chrome.storage.local.get(key))[key] as Receipt | undefined;
      if (receipt?.outcome==='confirmed' || command.delivered) s = complete(s,s.operation,receipt?.outcome==='confirmed'?receipt:{id:s.operation.id,outcome:'confirmed',detail:'User checked the chat',at:Date.now()},receipt?.outcome!=='confirmed');
      else {
        if (Date.now()-s.operation.startedAt < 90_000) throw new Error('Wait 90 seconds from the attempt so any in-flight submission can finish, then check the chat again.');
        s = {...s,status:'ERROR',submission:'failed',error:'You confirmed the message is absent. Remove any BreakBuddy draft before retrying.'};
      }
      await save(s); await restoreAlarms(s); if(s.backPending) await remind(s,true); else await auxiliary(closeReminder); return s;
    }
    case 'SNOOZE':
      if(!s.backPending) return s;
      s = {...s,snoozeUntil:Date.now()+5*60_000}; await save(s); await restoreAlarms(s); await auxiliary(closeReminder); return s;
    case 'OPEN_CLIQ': await findTab(s.group,true,s.customDestination); return s;
    case 'INSPECT': return inspect(s.group,s.profile,false,s.customDestination);
    case 'CHECK_SETUP': return inspect(s.group,s.profile,true,s.customDestination);
    case 'SAVE_CONFIG': {
      if (!['AVAILABLE','ERROR','BACK_PENDING'].includes(s.status)) throw new Error('Settings cannot change during an active schedule or uncertain send.');
      if (command.group !== 'test' && command.group !== 'production' && command.group !== 'custom') throw new Error('Unknown group.');
      if (s.status !== 'AVAILABLE' && command.group !== s.group) throw new Error('Finish the current break before changing destination.');
      const custom = command.group==='custom' ? parseCustomDestination(command.customUrl ?? '',command.customName ?? '') : s.customDestination;
      const customChanged = command.group==='custom' && JSON.stringify(custom)!==JSON.stringify(s.customDestination);
      if(customChanged && s.status!=='AVAILABLE') throw new Error('Finish the current break before changing destination.');
      if(command.group==='custom' && (!s.productionEnabled || s.group!=='custom' || customChanged) && command.phrase!=='ENABLE CUSTOM') throw new Error('Type ENABLE CUSTOM to enable automatic messages to this destination.');
      if(command.group==='production' && (!s.productionEnabled || s.group!=='production') && command.phrase!=='ENABLE MARTECH') throw new Error('Type ENABLE MARTECH to enable production.');
      if(!command.profile || Object.keys(s.profile).some(k=>typeof command.profile[k as keyof typeof s.profile] !== 'string' || command.profile[k as keyof typeof s.profile].length>1000)) throw new Error('Invalid selector profile.');
      if(command.group==='custom' && custom) await saveDestination(custom.url,custom.name);
      s={...s,group:command.group,productionEnabled:command.group!=='test',customDestination:custom,profile:command.profile}; await save(s); return s;
    }
  }
}
const run = (task:()=>Promise<unknown>) => {void serial(task).catch(error=>console.error('BreakBuddy:',error));};
registerPanelAction();
chrome.runtime.onMessage.addListener((command: Command, sender: any, respond: any) => {
  // Only extension pages can schedule, reconfigure, or authorize a send.
  if(sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !command?.type || command.type.startsWith('BB_')) return false;
  if(command.type==='PANEL_VISIBILITY') {
    if(!sender.documentId || !sender.url.startsWith(chrome.runtime.getURL('sidepanel.html'))) return false;
    void serial(async()=>{await recordPanelVisibility(sender.documentId,command.windowId,command.visible);respond({ok:true,data:null});})
      .catch(error=>respond({ok:false,error:String(error)}));
    return true;
  }
  void serial(()=>handle(command)).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:String(error.message ?? error)})); return true;
});
chrome.alarms.onAlarm.addListener((alarm:{name:string})=>{
  if(alarm.name===TELEGRAM_POLL_ALARM) {
    if(!telegramPoll){telegramPollRequest=fetchTelegramActions();telegramPoll=telegramPollRequest.then(batch=>{
      if(batch)return serial(()=>processTelegramActions(batch,async action=>{
        const state=await recover(false);
        const command=commandForTelegramAction(action,state,(await readCustom()).jobs);
        await handle(command);
        return action.kind==='back'?'Back requested. See its delivery report.':action.kind==='snooze'?'Back reminder snoozed for 5 minutes.':'Schedule cancelled.';
      }));
    }).catch(()=>console.warn('BreakBuddy: Telegram actions are unavailable.')).finally(()=>{telegramPoll=null;telegramPollRequest=null;});}
    return telegramPoll;
  }
  run(()=>recover());
});
chrome.runtime.onInstalled.addListener(()=>run(()=>recover(true,true)));
chrome.runtime.onStartup.addListener(()=>run(()=>recover(true,true)));
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state:string)=>{if(state==='active') run(async()=>{await recover(); await remind(await readState(),true);});});
chrome.windows.onFocusChanged.addListener((id:number)=>{if(id!==chrome.windows.WINDOW_ID_NONE) run(()=>recover());});
chrome.notifications.onButtonClicked.addListener((id:string,index:number)=>{
  const command: Command | null = id==='bb-back' ? (index===0?{type:'BACK'}:{type:'SNOOZE'}) : id==='bb-overdue' ? (index===0?{type:'SEND_NOW'}:{type:'CANCEL'}) : null;
  if(command) run(()=>handle(command)); else run(()=>chrome.tabs.create({url:chrome.runtime.getURL('popup.html')}));
});
chrome.notifications.onClicked.addListener(()=>run(()=>chrome.tabs.create({url:chrome.runtime.getURL('popup.html')})));
// Worker evaluation also happens on browser startup. Only the actual event may authorize a due send.
run(()=>recover(false));
