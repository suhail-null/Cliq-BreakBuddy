import {beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultState,groupUrl,BREAK_ALARM,REMINDER_ALARM} from '../src/config';
import type {Command,State} from '../src/types';
type Listener=(...args:any[])=>any;
function event(){const listeners:Listener[]=[];return {listeners,addListener:(fn:Listener)=>listeners.push(fn),removeListener:(fn:Listener)=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}};}
let store:Record<string,any>;let api:any;let alarmStore:Map<string,any>;let outcome='confirmed';
async function request(command:Command){return new Promise<any>(resolve=>api.runtime.onMessage.listeners[0](command,{id:'test-extension',url:'chrome-extension://test-extension/popup.html'},resolve));}
async function state(){return (await request({type:'GET'})).data as State;}
beforeEach(async()=>{
  vi.resetModules();outcome='confirmed';
  store={state:{...defaultState(),productionEnabled:true,profile:{root:'#chat',chatIdAttribute:'data-id',header:'.title',editor:'textarea',send:'button',row:'.row',rowIdAttribute:'data-message',body:'.body',own:'.own',acknowledged:'.sent'}}};
  alarmStore=new Map();
  api={storage:{local:{get:vi.fn(async(key:string|string[])=>Object.fromEntries((Array.isArray(key)?key:[key]).map(k=>[k,structuredClone(store[k])])) ),set:vi.fn(async(update:any)=>{Object.assign(store,structuredClone(update));})}},
    action:{setBadgeText:vi.fn(),setBadgeBackgroundColor:vi.fn(),setTitle:vi.fn(),onClicked:event()},
    alarms:{get:vi.fn(async(name:string)=>alarmStore.get(name)),create:vi.fn(async(name:string,info:any)=>{alarmStore.set(name,{...info,scheduledTime:info.when});}),clear:vi.fn(async(name:string)=>alarmStore.delete(name)),onAlarm:event()},
    runtime:{id:'test-extension',getURL:(name:string)=>`chrome-extension://test-extension/${name}`,onMessage:event(),onInstalled:event(),onStartup:event()},
    tabs:{query:vi.fn(async()=>[{id:5,windowId:1,url:groupUrl('test'),status:'complete'}]),get:vi.fn(async()=>({status:'complete'})),update:vi.fn(),create:vi.fn(async()=>({id:6})),remove:vi.fn(async()=>{}),onUpdated:event(),sendMessage:vi.fn(async(_id:number,msg:any)=>{
      if(msg.type==='BB_PING' || msg.type==='BB_READY') return {ok:true}; if(msg.type==='BB_CHECK') return {ok:true};
      if(msg.type==='BB_SEND') return {id:msg.operation.id,outcome,at:Date.now(),detail:outcome};
    })},
    windows:{WINDOW_ID_NONE:-1,onFocusChanged:event(),create:vi.fn(),update:vi.fn()},
    notifications:{create:vi.fn(),clear:vi.fn(),onButtonClicked:event(),onClicked:event()},
    idle:{queryState:vi.fn(async()=> 'active'),setDetectionInterval:vi.fn(),onStateChanged:event()},
    scripting:{executeScript:vi.fn()}};
  vi.stubGlobal('chrome',api);
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({ok:true,result:{message_id:1}})})));
  await import('../src/background/index');await request({type:'GET'});
});
const sends=()=>api.tabs.sendMessage.mock.calls.filter((args:any[])=>args[1].type==='BB_SEND');
async function pressTelegram(kind:string,updateId=10) {
  const report=store.telegramReports.find((r:any)=>r.buttons?.some((b:any)=>b.action.kind===kind&&!b.used));
  const button=report.buttons.find((b:any)=>b.action.kind===kind);
  const update={update_id:updateId,callback_query:{id:`query-${updateId}`,from:{id:123456789,is_bot:false},data:`bb:${button.token}`,message:{message_id:report.messageIds[0],date:Math.floor(Date.now()/1000),chat:{id:123456789}}}};
  vi.mocked(fetch).mockImplementation(async(url:any)=>({ok:true,status:200,json:async()=>({ok:true,result:String(url).endsWith('/getUpdates')?[update]:String(url).endsWith('/sendMessage')?{message_id:updateId+1}:true})}) as Response);
  if(store.telegramActionPoll)store.telegramActionPoll.nextAt=0;
  await api.alarms.onAlarm.listeners[0]({name:'breakbuddy-telegram-actions'});
}
describe('background service worker',()=>{
  it('snoozes then sends Back through real Telegram callbacks using the existing state machine',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-100};api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});await state();
    expect(sends()).toHaveLength(1);await pressTelegram('snooze');
    expect(store.state.backPending).toBe(true);expect(store.state.snoozeUntil).toBeGreaterThan(Date.now()+290_000);expect(sends()).toHaveLength(1);
    expect(store.telegramReports.some((r:any)=>r.text.includes('Back reminder snoozed'))).toBe(true);
    await pressTelegram('back',11);expect(store.state.status).toBe('AVAILABLE');expect(store.state.backPending).toBe(false);expect(sends()).toHaveLength(2);
    expect(sends()[1][1].operation.text).toBe('Back');expect(store.telegramLastAction.ok).toBe(true);
  });
  it('cancels custom and Break schedules from Telegram and reports both cancellations without a send',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    await request({type:'SCHEDULE',minutes:10});
    await request({type:'SCHEDULE_CUSTOM',text:'DSR',url:'https://cliq.zoho.com/company/717321507/chats/CT_reports',name:'Reports',scheduledAt:Date.now()+60_000});
    await pressTelegram('cancel-custom');expect(store.customJobs[0].status).toBe('cancelled');expect(store.state.status).toBe('BREAK_SCHEDULED');
    await pressTelegram('cancel-break',11);expect(store.state.status).toBe('AVAILABLE');expect(alarmStore.has(BREAK_ALARM)).toBe(false);expect(sends()).toHaveLength(0);
    expect(store.telegramReports.filter((r:any)=>r.text.includes('schedule cancelled'))).toHaveLength(2);
  });
  it('keeps a stale Telegram return button from authorizing an uncertain Back retry',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-100};api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});await state();
    store.state={...store.state,status:'UNCERTAIN',submission:'uncertain',operation:{id:'uncertain-back',text:'Back',group:'production',startedAt:Date.now()}};
    await pressTelegram('back');expect(sends()).toHaveLength(1);expect(store.state.status).toBe('UNCERTAIN');expect(store.telegramLastAction.ok).toBe(false);
  });
  it('does not block a new schedule while an incoming Telegram long poll is waiting',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    let finish!:(response:any)=>void;
    vi.mocked(fetch).mockImplementation(async(url:any)=>String(url).endsWith('/getUpdates')?new Promise(resolve=>{finish=resolve;}):({ok:true,status:200,json:async()=>({ok:true,result:{message_id:1}})} as Response));
    const polling=api.alarms.onAlarm.listeners[0]({name:'breakbuddy-telegram-actions'});
    expect((await request({type:'SCHEDULE',minutes:10})).ok).toBe(true);expect(store.state.status).toBe('BREAK_SCHEDULED');
    finish({ok:true,status:200,json:async()=>({ok:true,result:[]})});await polling;
  });
  it('waits for the current long poll before discovering chats with the same bot',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    let finish!:(response:any)=>void;
    vi.mocked(fetch).mockImplementation(async(url:any,options:any)=>{
      if(String(url).endsWith('/getUpdates'))return JSON.parse(options.body).timeout===20?new Promise(resolve=>{finish=resolve;}):({ok:true,status:200,json:async()=>({ok:true,result:[{message:{chat:{id:123456789,first_name:'Me'}}}]})} as Response);
      return {ok:true,status:200,json:async()=>({ok:true,result:true})} as Response;
    });
    const polling=api.alarms.onAlarm.listeners[0]({name:'breakbuddy-telegram-actions'});await state();
    const finding=request({type:'FIND_TELEGRAM_CHATS',botToken:''});
    finish({ok:true,status:200,json:async()=>({ok:true,result:[]})});
    expect((await finding).data).toEqual([{id:'123456789',name:'Me'}]);await polling;
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith('/getUpdates')).map(([,options])=>JSON.parse(options!.body as string).timeout)).toEqual([20,0]);
  });
  it('confirms a newly scheduled Break in Telegram once, then reports delivery separately',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    const result=await request({type:'SCHEDULE',minutes:10});
    expect(result.ok).toBe(true);expect(store.state.status).toBe('BREAK_SCHEDULED');expect(sends()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const scheduled=JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).text;
    expect(scheduled).toContain('BreakBuddy: Break scheduled');expect(scheduled).toContain('Chat: MarTech');expect(scheduled).toContain('Scheduled for:');expect(scheduled).not.toContain('successfully sent');
    await state();api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});await state();
    expect(fetch).toHaveBeenCalledTimes(1);expect(sends()).toHaveLength(0);
    const now=vi.spyOn(Date,'now').mockReturnValue(store.state.scheduledAt);
    try {
      api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});await state();
      expect(fetch).toHaveBeenCalledTimes(2);expect(sends()).toHaveLength(1);
      expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).text).toContain('Message successfully sent');
    } finally {now.mockRestore();}
  });
  it('keeps a Break scheduled and its alarm armed when its Telegram confirmation fails',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const result=await request({type:'SCHEDULE',minutes:10});
    expect(result.ok).toBe(true);expect(store.state.status).toBe('BREAK_SCHEDULED');expect(alarmStore.get(BREAK_ALARM).when).toBe(store.state.scheduledAt);
    expect(store.telegramReports[0]).toMatchObject({status:'pending',text:expect.stringContaining('Break scheduled')});expect(sends()).toHaveLength(0);
  });
  it('does not send a scheduling confirmation for a rejected schedule or when Telegram is disabled',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    expect((await request({type:'SCHEDULE',minutes:0})).ok).toBe(false);expect(fetch).not.toHaveBeenCalled();
    store.state.productionEnabled=false;
    expect((await request({type:'SCHEDULE',minutes:10})).ok).toBe(false);expect(fetch).not.toHaveBeenCalled();
    await request({type:'SAVE_TELEGRAM',enabled:false,botToken:'',chatId:'123456789'});store.state.productionEnabled=true;
    expect((await request({type:'SCHEDULE',minutes:10})).ok).toBe(true);expect(fetch).not.toHaveBeenCalled();
  });
  it('reports Break and Back once each without replaying them on repeated recovery',async()=>{
    expect((await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'})).ok).toBe(true);
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-500};api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});
    await state();await state();await request({type:'BACK'});await state();
    expect(sends()).toHaveLength(2);expect(fetch).toHaveBeenCalledTimes(2);
    const texts=vi.mocked(fetch).mock.calls.map(([,options])=>JSON.parse(options!.body as string).text);
    expect(texts[0]).toContain('Message: Break');expect(texts[1]).toContain('Message: Back');
    expect((await request({type:'GET_TELEGRAM'})).data).not.toHaveProperty('botToken');
  });
  it('preserves confirmed Cliq delivery when Telegram is unavailable',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));store.state={...store.state,status:'BACK_PENDING',backPending:true};
    expect((await request({type:'BACK'})).ok).toBe(true);expect(store.state.status).toBe('AVAILABLE');expect(store.state.history[0].text).toBe('Back');
    expect(store.telegramReports[0].status).toBe('pending');expect(sends()).toHaveLength(1);
  });
  it('reports a custom message from its alarm using the captured destination',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    await request({type:'SCHEDULE_CUSTOM',text:'DSR\nCompleted my report',url:'https://cliq.zoho.com/company/717321507/chats/CT_reports',name:'Reports',scheduledAt:Date.now()+60_000});
    store.customJobs[0].scheduledAt=Date.now()-100;api.alarms.onAlarm.listeners[0]({name:'breakbuddy-custom'});await state();await state();
    expect(fetch).toHaveBeenCalledTimes(2);expect(sends()).toHaveLength(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).text).toContain('Custom message scheduled');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).text).toContain('Chat: Reports');
    expect(store.customJobs[0].status).toBe('sent');expect(store.state.status).toBe('AVAILABLE');
  });
  it('reports a recovered receipt after worker interruption without another Cliq send',async()=>{
    await request({type:'SAVE_TELEGRAM',enabled:true,botToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789',chatId:'123456789'});
    const op={id:'recovered',text:'Back',group:'production',startedAt:Date.now()};
    store.state={...store.state,status:'SENDING_BACK',backPending:true,operation:op};
    store['receipt:recovered']={id:op.id,outcome:'confirmed',at:Date.now(),detail:'sent'};
    await state();await state();expect(fetch).toHaveBeenCalledTimes(1);expect(sends()).toHaveLength(0);expect(store.state.status).toBe('AVAILABLE');
  });
  it('requires destination activation before scheduling a new MarTech break',async()=>{
    store.state.productionEnabled=false;expect((await request({type:'SCHEDULE',minutes:1})).ok).toBe(false);expect(sends()).toHaveLength(0);expect(store.state.scheduledAt).toBeNull();
  });
  it('runs a custom report through its separate commands and alarm while Back remains pending',async()=>{
    store.state={...store.state,status:'BACK_PENDING',backPending:true,lastReminderAt:Date.now()};
    const result=await request({type:'SCHEDULE_CUSTOM',text:'DSR\nWork completed',url:'https://cliq.zoho.com/company/717321507/chats/CT_reports',name:'Reports',scheduledAt:Date.now()+60_000});
    expect(result.ok).toBe(true);expect(store.state.status).toBe('BACK_PENDING');expect(store.state.operation).toBeNull();
    store.customJobs[0].scheduledAt=Date.now()-100;api.alarms.onAlarm.listeners[0]({name:'breakbuddy-custom'});await state();
    expect(store.customJobs[0].status).toBe('sent');expect(sends()).toHaveLength(1);expect(sends()[0][1].operation.kind).toBe('custom');
    expect(store.state.backPending).toBe(true);expect(store.state.group).toBe('production');expect(store.state.operation).toBeNull();
  });
  it('accepts a one-minute schedule in explicitly enabled production mode',async()=>{
    expect((await request({type:'SAVE_CONFIG',group:'production',phrase:'ENABLE MARTECH',profile:store.state.profile})).ok).toBe(true);
    expect((await request({type:'SCHEDULE',minutes:1})).ok).toBe(true);
    expect(store.state.group).toBe('production');expect(store.state.status).toBe('BREAK_SCHEDULED');expect(sends()).toHaveLength(0);
  });
  it('requires confirmation for custom destinations and snapshots the destination into sends',async()=>{
    const config={type:'SAVE_CONFIG' as const,group:'custom' as const,phrase:'',profile:store.state.profile,customUrl:'https://cliq.zoho.com/company/717321507/chats/CT_example',customName:'Team room'};
    expect((await request(config)).ok).toBe(false);
    expect((await request({...config,phrase:'ENABLE CUSTOM'})).ok).toBe(true);
    store.state={...store.state,status:'BACK_PENDING',backPending:true};
    expect((await request({...config,phrase:'ENABLE CUSTOM',customUrl:'https://cliq.zoho.com/company/717321507/chats/CT_changed'})).ok).toBe(false);
    await request({type:'BACK'});
    expect(sends()[0][1].operation.destination.name).toBe('Team room');
    expect(sends()[0][1].operation.destination.id).toBe('CT_example');
  });
  it.each([10,20])('persists %i minutes and creates a Chrome alarm',async(minutes)=>{const before=Date.now();const result=await request({type:'SCHEDULE',minutes});expect(result.ok).toBe(true);expect(store.state.scheduledAt).toBeGreaterThanOrEqual(before+minutes*60_000);expect(alarmStore.get(BREAK_ALARM).when).toBe(store.state.scheduledAt);});
  it('cancels an alarm without sending',async()=>{await request({type:'SCHEDULE',minutes:10});await request({type:'CANCEL'});expect((await state()).status).toBe('AVAILABLE');expect(alarmStore.has(BREAK_ALARM)).toBe(false);expect(sends()).toHaveLength(0);});
  it('sends a due Break from an alarm while the popup is closed',async()=>{
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-500};
    api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});
    expect((await state()).status).toBe('BACK_PENDING');expect(sends()).toHaveLength(1);
  });
  it('serializes repeated alarm and return actions without duplicate sends',async()=>{
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-500};
    api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});
    await state();expect(sends()).toHaveLength(1);
    const results=await Promise.all([request({type:'BACK'}),request({type:'BACK'})]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);expect(sends()).toHaveLength(2);expect(store.state.backPending).toBe(false);
  });
  it('requires user confirmation for stale schedules',async()=>{
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-3*60*60_000};api.alarms.onAlarm.listeners[0]({name:BREAK_ALARM});
    expect((await state()).status).toBe('OVERDUE');expect(sends()).toHaveLength(0);
    await request({type:'SEND_NOW'});expect(sends()).toHaveLength(1);
  });
  it('treats any deadline missed across a browser restart as overdue',async()=>{
    store.state={...store.state,status:'BREAK_SCHEDULED',scheduledAt:Date.now()-500};api.runtime.onStartup.listeners[0]();
    expect((await state()).status).toBe('OVERDUE');expect(sends()).toHaveLength(0);
  });
  it('does not send Back automatically when the machine becomes active',async()=>{
    store.state={...store.state,status:'BACK_PENDING',backPending:true,breakSentAt:Date.now()};api.idle.onStateChanged.listeners[0]('active');await state();
    expect(sends()).toHaveLength(0);expect(api.windows.create).toHaveBeenCalled();expect(store.state.backPending).toBe(true);
  });
  it('snoozes reminders while keeping Back pending',async()=>{
    store.state={...store.state,status:'BACK_PENDING',backPending:true};await request({type:'SNOOZE'});
    expect(store.state.backPending).toBe(true);expect(store.state.snoozeUntil).toBeGreaterThan(Date.now()+299_000);expect(alarmStore.has(REMINDER_ALARM)).toBe(true);
  });
  it('keeps Back pending when a Back send fails',async()=>{
    store.state={...store.state,status:'BACK_PENDING',backPending:true};outcome='failed';await request({type:'BACK'});
    expect(store.state.status).toBe('ERROR');expect(store.state.backPending).toBe(true);
  });
  it('blocks automatic retries of uncertain sends',async()=>{
    store.state={...store.state,status:'BACK_PENDING',backPending:true};outcome='uncertain';await request({type:'BACK'});
    expect(store.state.status).toBe('UNCERTAIN');expect((await request({type:'RETRY'})).ok).toBe(false);expect(sends()).toHaveLength(1);
  });
  it('restores an interrupted send from its durable receipt without replaying it',async()=>{
    const op={id:'interrupted',text:'Break',group:'test',startedAt:Date.now()-1000};store.state={...store.state,status:'SENDING_BREAK',operation:op};
    store['receipt:interrupted']={id:'interrupted',outcome:'confirmed',at:Date.now(),detail:'sent'};
    expect((await state()).status).toBe('BACK_PENDING');expect(sends()).toHaveLength(0);
  });
  it('preserves interrupted sends without a receipt for manual review',async()=>{
    store.state={...store.state,status:'SENDING_BACK',backPending:true,operation:{id:'lost',text:'Back',group:'test',startedAt:Date.now()}};
    expect((await state()).status).toBe('UNCERTAIN');expect(store.state.backPending).toBe(true);expect(sends()).toHaveLength(0);
  });
  it('requires production confirmation and forbids switching group mid-break',async()=>{
    store.state.productionEnabled=false;
    expect((await request({type:'SAVE_CONFIG',group:'production',phrase:'',profile:store.state.profile})).ok).toBe(false);
    store.state={...store.state,group:'custom',customDestination:{name:'Team',id:'CT_example',url:'https://cliq.zoho.com/company/717321507/chats/CT_example'},status:'BACK_PENDING',backPending:true};
    expect((await request({type:'SAVE_CONFIG',group:'production',phrase:'ENABLE MARTECH',profile:store.state.profile})).ok).toBe(false);
    expect(store.state.group).toBe('custom');expect(sends()).toHaveLength(0);
  });
  it('rejects configuration messages originating from web pages',()=>{
    const respond=vi.fn();const result=api.runtime.onMessage.listeners[0]({type:'BACK'},{id:'test-extension',url:groupUrl('test')},respond);
    expect(result).toBe(false);expect(respond).not.toHaveBeenCalled();
  });
});
