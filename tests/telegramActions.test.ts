import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultState} from '../src/config';
import type {CustomJob,State} from '../src/types';
import {breakCycleReference,disconnectTelegram,flushTelegramReports,queueTelegramState,saveTelegramSettings} from '../src/services/telegramNotifier';
import {commandForTelegramAction,fetchTelegramActions,processTelegramActions,restoreTelegramPolling,TELEGRAM_POLL_ALARM} from '../src/services/telegramActions';

const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';
let store:Record<string,any>;let api:any;let updates:any[];let nextMessage:number;let fetchMock:ReturnType<typeof vi.fn>;
const response=(result:any,status=200)=>({ok:status===200,status,json:async()=>status===200?{ok:true,result}:{ok:false,error_code:status,parameters:{retry_after:120}}});
beforeEach(()=>{
  store={};updates=[];nextMessage=1;
  api={storage:{local:{get:vi.fn(async(keys:string[])=>Object.fromEntries(keys.map(key=>[key,structuredClone(store[key])]))),set:vi.fn(async(data:any)=>Object.assign(store,structuredClone(data)))}},alarms:{get:vi.fn(),create:vi.fn(),clear:vi.fn()}};
  vi.stubGlobal('chrome',api);
  fetchMock=vi.fn(async(url:string)=>response(url.endsWith('/getUpdates')?updates:url.endsWith('/sendMessage')?{message_id:nextMessage++}:true));
  vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>vi.unstubAllGlobals());
const requests=(method:string)=>fetchMock.mock.calls.filter((call:any)=>call[0].endsWith(`/${method}`));
async function schedule(chatId='123456789',controllerId?:string) {
  await saveTelegramSettings(true,token,chatId,controllerId);
  const state:State={...defaultState(),status:'BREAK_SCHEDULED',scheduledAt:Date.now()+60_000};
  await queueTelegramState(state);await flushTelegramReports();return state;
}
function callback(report=store.telegramReports[0],from=123456789,chat:any={id:123456789},updateId=10) {
  return {update_id:updateId,callback_query:{id:`query-${updateId}`,from:{id:from,is_bot:false},data:`bb:${report.buttons[0].token}`,message:{message_id:report.messageIds[0],date:Math.floor(Date.now()/1000),chat}}};
}
async function process(execute=vi.fn(async()=> 'Done')) {
  const batch=await fetchTelegramActions();expect(batch).not.toBeNull();await processTelegramActions(batch!,execute);return execute;
}

describe('Telegram action polling and authorization',()=>{
  it('puts short unique callbacks on reports and restores a 30-second polling alarm',async()=>{
    await schedule();await restoreTelegramPolling();
    const markup=JSON.parse(requests('sendMessage')[0][1].body).reply_markup;
    expect(markup.inline_keyboard[0][0]).toMatchObject({text:'Cancel schedule',callback_data:expect.stringMatching(/^bb:[a-f0-9]{32}$/)});
    expect(markup.inline_keyboard[0][0].callback_data.length).toBeLessThanOrEqual(64);
    expect(api.alarms.create).toHaveBeenCalledWith(TELEGRAM_POLL_ALARM,{periodInMinutes:0.5});
    api.alarms.get.mockResolvedValue({name:TELEGRAM_POLL_ALARM});await restoreTelegramPolling();expect(api.alarms.create).toHaveBeenCalledTimes(1);
  });
  it('long-polls without blocking Cliq work and includes the committed update offset next time',async()=>{
    await schedule();updates=[{update_id:12,message:{text:'/start'}}];await process();
    expect(JSON.parse(requests('getUpdates')[0][1].body)).toMatchObject({timeout:20,limit:25,allowed_updates:expect.arrayContaining(['callback_query'])});
    store.telegramActionPoll.nextAt=0;await fetchTelegramActions();
    expect(JSON.parse(requests('getUpdates')[1][1].body).offset).toBe(13);
  });
  it('accepts a button only from its configured private chat and persists consumption before dispatch',async()=>{
    await schedule();updates=[callback()];
    const execute=vi.fn(async()=>{
      expect(store.telegramActionPoll.offset).toBe(11);expect(store.telegramReports[0].buttons[0].used).toBe(true);return 'Cancelled';
    });
    await process(execute);expect(execute).toHaveBeenCalledWith(expect.objectContaining({kind:'cancel-break'}));
    expect(requests('answerCallbackQuery')).toHaveLength(1);expect(requests('editMessageReplyMarkup')).toHaveLength(1);
    const batch={config:store.telegramConfig,updates};await processTelegramActions(batch,execute);expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(['user','chat','message','data','bot','inaccessible'])('rejects an invalid %s without dispatching',async(invalid)=>{
    await schedule();const update=callback();
    if(invalid==='user')update.callback_query.from.id=987654321;
    if(invalid==='chat')update.callback_query.message.chat.id=-100123;
    if(invalid==='message')update.callback_query.message.message_id=999;
    if(invalid==='data')update.callback_query.data='bb:made-up-token';
    if(invalid==='bot')update.callback_query.from.is_bot=true;
    if(invalid==='inaccessible')update.callback_query.message.date=0;
    updates=[update];const execute=await process();expect(execute).not.toHaveBeenCalled();expect(store.telegramActionPoll.offset).toBe(11);
  });
  it('requires a named controller in group chats and only accepts that user',async()=>{
    await schedule('-100123');await restoreTelegramPolling();expect(api.alarms.clear).toHaveBeenCalledWith(TELEGRAM_POLL_ALARM);
    expect(JSON.parse(requests('sendMessage')[0][1].body)).not.toHaveProperty('reply_markup');expect(await fetchTelegramActions()).toBeNull();
    await schedule('-100123','123456789');updates=[callback(store.telegramReports[0],987654321,{id:-100123},20),callback(store.telegramReports[0],123456789,{id:-100123},21)];
    const execute=await process();expect(execute).toHaveBeenCalledTimes(1);
  });
  it('binds a channel username and still checks the controller ID',async()=>{
    await schedule('@ReportsChannel','123456789');updates=[callback(store.telegramReports[0],123456789,{id:-100123,username:'reportschannel'})];
    expect(await process()).toHaveBeenCalledTimes(1);
  });
  it('rejects another click on the same button even with a new update ID',async()=>{
    await schedule();updates=[callback()];const execute=await process();
    store.telegramActionPoll.nextAt=0;updates=[callback(store.telegramReports[0],123456789,{id:123456789},11)];await process(execute);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('discards in-flight updates from a bot that was disconnected or replaced',async()=>{
    await schedule();updates=[callback()];const batch=await fetchTelegramActions();
    await disconnectTelegram();await saveTelegramSettings(true,'987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789','123456789');
    const execute=vi.fn(async()=> 'Done');await processTelegramActions(batch!,execute);expect(execute).not.toHaveBeenCalled();
  });
  it('records a rejected stale action once and never replays it after a dispatch failure',async()=>{
    await schedule();updates=[callback()];const execute=vi.fn(async()=>{throw new Error('The schedule already started');});
    await process(execute);expect(store.telegramLastAction).toMatchObject({ok:false,detail:expect.stringContaining('already started')});
    expect(store.telegramReports.some((r:any)=>r.text.includes('Action not applied'))).toBe(true);
    store.telegramActionPoll.nextAt=0;updates=[callback(store.telegramReports[0],123456789,{id:123456789},11)];await process(execute);expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not drop an authorized action when the callback acknowledgment has expired',async()=>{
    await schedule();updates=[callback()];fetchMock.mockImplementation(async(url:string)=>response(url.endsWith('/getUpdates')?updates:true,url.endsWith('/answerCallbackQuery')?400:200));
    expect(await process()).toHaveBeenCalledTimes(1);
  });
  it('backs off polling after rate limits and keeps the error separate from message delivery',async()=>{
    await schedule();fetchMock.mockImplementation(async(url:string)=>response(true,url.endsWith('/getUpdates')?429:200));
    const before=Date.now();expect(await fetchTelegramActions()).toBeNull();expect(store.telegramActionPoll.nextAt).toBeGreaterThanOrEqual(before+120_000);
    expect(store.telegramActionsError).toContain('rate limit');await fetchTelegramActions();expect(requests('getUpdates')).toHaveLength(1);expect(store.telegramReports[0].status).toBe('sent');
  });
});

describe('Telegram actions use the current BreakBuddy state',()=>{
  const pending=():State=>({...defaultState(),status:'BACK_PENDING',backPending:true,breakSentAt:Date.now(),history:[{id:'break-cycle',text:'Break',group:'production',at:Date.now(),proof:'ui'}]});
  it('maps return and snooze to existing commands for the same pending cycle',()=>{
    const state=pending();const reference=breakCycleReference(state);
    expect(commandForTelegramAction({kind:'back',reference},state,[])).toEqual({type:'BACK'});
    expect(commandForTelegramAction({kind:'snooze',reference},state,[])).toEqual({type:'SNOOZE'});
    expect(()=>commandForTelegramAction({kind:'back',reference:'old-cycle'},state,[])).toThrow('cycle');
    expect(()=>commandForTelegramAction({kind:'back',reference},{...state,backPending:false},[])).toThrow('cycle');
  });
  it.each(['UNCERTAIN','SENDING_BACK','SENDING_BREAK'] as const)('blocks a return action while status is %s',status=>{
    expect(()=>commandForTelegramAction({kind:'back',reference:'break-cycle'},{...pending(),status},[])).toThrow('Resolve');
  });
  it('allows cancellation only for the same pending Break deadline',()=>{
    const state:State={...defaultState(),status:'BREAK_SCHEDULED',scheduledAt:100000};
    expect(commandForTelegramAction({kind:'cancel-break',reference:'100000'},state,[])).toEqual({type:'CANCEL'});
    expect(()=>commandForTelegramAction({kind:'cancel-break',reference:'99999'},state,[])).toThrow('changed');
    expect(()=>commandForTelegramAction({kind:'cancel-break',reference:'100000'},{...state,status:'SENDING_BREAK'},[])).toThrow('already started');
  });
  it('binds custom cancellation to both the job and its current scheduled time',()=>{
    const job={id:'job',status:'scheduled',scheduledAt:100000} as CustomJob;
    const action={kind:'cancel-custom' as const,jobId:'job',reference:'100000'};
    expect(commandForTelegramAction(action,defaultState(),[job])).toEqual({type:'CUSTOM_ACTION',id:'job',action:'cancel'});
    expect(()=>commandForTelegramAction(action,defaultState(),[{...job,scheduledAt:200000}])).toThrow('changed');
    expect(()=>commandForTelegramAction(action,defaultState(),[{...job,status:'uncertain'}])).toThrow('already started');
  });
});
