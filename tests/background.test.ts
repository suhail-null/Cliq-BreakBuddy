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
  await import('../src/background/index');await request({type:'GET'});
});
const sends=()=>api.tabs.sendMessage.mock.calls.filter((args:any[])=>args[1].type==='BB_SEND');
describe('background service worker',()=>{
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
