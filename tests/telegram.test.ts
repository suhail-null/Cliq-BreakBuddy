import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultState} from '../src/config';
import {disconnectTelegram,findTelegramChats,flushTelegramReports,getTelegramSettings,queueTelegramJobs,queueTelegramState,saveTelegramSettings,testTelegram} from '../src/services/telegramNotifier';
import type {CustomJob,State} from '../src/types';

const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';
const destination={name:'Reports',id:'CT_reports',url:'https://cliq.zoho.com/company/717321507/chats/CT_reports'};
let store:Record<string,any>;let fetchMock:ReturnType<typeof vi.fn>;
const response=(status=200,data:any={ok:true,result:{message_id:1}})=>({ok:status>=200&&status<300,status,json:async()=>data});
const confirmed=(id='sent',at=Date.now()):State=>({...defaultState(),history:[{id,text:'Break',group:'production',destination,at,proof:'ui'}]});
async function connect(){await saveTelegramSettings(true,token,'123456789');}
beforeEach(()=>{
  store={};vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(keys:string[])=>Object.fromEntries(keys.map(key=>[key,structuredClone(store[key])]))),set:vi.fn(async(data:any)=>Object.assign(store,structuredClone(data)))}}});
  fetchMock=vi.fn(async()=>response());vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('Telegram delivery reports',()=>{
  it('is disabled by default and makes no network request',async()=>{
    await queueTelegramState(confirmed());await flushTelegramReports();
    expect(fetchMock).not.toHaveBeenCalled();expect(await getTelegramSettings()).toMatchObject({enabled:false,hasToken:false,pending:0});
  });
  it('validates settings, keeps a saved token on blank input, and never returns it',async()=>{
    await expect(saveTelegramSettings(true,'','123')).rejects.toThrow('bot token and chat ID');
    await expect(saveTelegramSettings(true,'bad-token','123')).rejects.toThrow('BotFather');
    await expect(saveTelegramSettings(true,token,'https://attacker.test')).rejects.toThrow('chat ID');
    await connect();await saveTelegramSettings(true,'','-1001234567890');
    expect(store.telegramConfig.botToken).toBe(token);expect(JSON.stringify(await getTelegramSettings())).not.toContain(token);
    expect(await getTelegramSettings()).toMatchObject({hasToken:true,chatId:'-1001234567890'});
  });
  it('sends a test using the saved configuration and checks Telegram API success',async()=>{
    await connect();await testTelegram();
    const [url,options]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(options).toMatchObject({method:'POST',credentials:'omit',redirect:'error'});
    expect(JSON.parse(options.body as string)).toMatchObject({chat_id:'123456789',text:expect.stringContaining('BreakBuddy test')});
    expect((await getTelegramSettings()).lastReport?.ok).toBe(true);
    fetchMock.mockResolvedValueOnce(response(200,{ok:false,error_code:403}));
    await expect(testTelegram()).rejects.toThrow('permission');expect((await getTelegramSettings()).lastReport?.ok).toBe(false);
  });
  it('discovers private and group chat IDs without acknowledging updates or storing the input token',async()=>{
    fetchMock.mockResolvedValueOnce(response(200,{ok:true,result:[{message:{chat:{id:123,first_name:'Me'}}},{message:{chat:{id:-100123,title:'Team'}}},{message:{chat:{id:123,first_name:'Me'}}}]}));
    expect(await findTelegramChats(token)).toEqual([{id:'123',name:'Me'},{id:'-100123',name:'Team'}]);
    const payload=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toEqual({timeout:0,limit:100});expect(payload).not.toHaveProperty('offset');expect(store.telegramConfig).toBeUndefined();
  });
  it('explains missing chats and existing webhook conflicts without changing the bot',async()=>{
    fetchMock.mockResolvedValueOnce(response(200,{ok:true,result:[]}));
    await expect(findTelegramChats(token)).rejects.toThrow('/start');
    fetchMock.mockResolvedValueOnce(response(409,{ok:false,error_code:409}));
    await expect(findTelegramChats(token)).rejects.toThrow('webhook');expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reports confirmed sends once across repeated recovery and skips history before connection',async()=>{
    await connect();const state=confirmed();state.history.push({...state.history[0],id:'old',at:Date.now()-60_000});
    await queueTelegramState(state);await flushTelegramReports();await queueTelegramState(state);await flushTelegramReports();
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain('Message successfully sent');
    expect(store.telegramReports).toHaveLength(1);expect(store.telegramReports[0].status).toBe('sent');
  });
  it('keeps uncertainty distinct from failure and reports a later manual confirmation',async()=>{
    await connect();const op={id:'attempt',text:'Back',group:'production' as const,destination,startedAt:Date.now()};
    await queueTelegramState({...defaultState(),status:'UNCERTAIN',operation:op,error:'No independent proof'});
    await queueTelegramState({...confirmed(op.id),history:[{...confirmed(op.id).history[0],proof:'manual'}]});
    await flushTelegramReports();
    const texts=fetchMock.mock.calls.map((call:any)=>JSON.parse(call[1].body).text);
    expect(texts[0]).toContain('Delivery uncertain');expect(texts[0]).toContain('before retrying');expect(texts[0]).not.toContain('was not sent');
    expect(texts[1]).toContain('manual review');
  });
  it('reports definite failures and missed Break schedules',async()=>{
    await connect();await queueTelegramState({...defaultState(),status:'ERROR',operation:{id:'failed',text:'Break',group:'production',destination,startedAt:Date.now()},error:'Signed out'});
    await queueTelegramState({...defaultState(),status:'OVERDUE',scheduledAt:Date.now(),error:'Device unavailable'});await flushTelegramReports();
    const texts=fetchMock.mock.calls.map((call:any)=>JSON.parse(call[1].body).text);
    expect(texts[0]).toContain('Message was not sent');expect(texts[0]).toContain('Signed out');expect(texts[1]).toContain('missed — not sent');
  });
  it('reports custom jobs with their captured chat and a bounded plain-text preview',async()=>{
    await connect();const job={id:'job',text:'<b>DSR</b>\n'+'x'.repeat(20000),destination,status:'sent',at:Date.now(),operation:{id:'op'}} as CustomJob;
    await queueTelegramJobs([job]);await flushTelegramReports();await queueTelegramJobs([job]);await flushTelegramReports();
    const payload=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.text).toContain('Reports');expect(payload.text).toContain('<b>DSR</b>');expect(payload.text.length).toBeLessThan(600);expect(payload).not.toHaveProperty('parse_mode');expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('retries only the Telegram report after temporary network failure and never leaks fetch errors',async()=>{
    await connect();await queueTelegramState(confirmed());fetchMock.mockRejectedValueOnce(new Error(`Failed request https://api.telegram.org/bot${token}/sendMessage`));
    await flushTelegramReports();expect((await getTelegramSettings()).pending).toBe(1);expect(JSON.stringify(await getTelegramSettings())).not.toContain(token);
    await flushTelegramReports();expect(fetchMock).toHaveBeenCalledTimes(1);
    store.telegramReports[0].nextAt=Date.now()-1;await flushTelegramReports();expect(fetchMock).toHaveBeenCalledTimes(2);expect((await getTelegramSettings()).pending).toBe(0);
  });
  it('respects rate limits, stops the batch, and eventually stops retrying a failed report',async()=>{
    await connect();await queueTelegramState(confirmed('first'));await queueTelegramState(confirmed('second'));
    fetchMock.mockResolvedValue(response(429,{ok:false,error_code:429,parameters:{retry_after:120}}));
    const now=Date.now();await flushTelegramReports();expect(fetchMock).toHaveBeenCalledTimes(1);expect(store.telegramReports[0].nextAt).toBeGreaterThanOrEqual(now+120_000);
    await flushTelegramReports();expect(fetchMock).toHaveBeenCalledTimes(1); // Other reports also respect the rate limit.
    // Isolate the rate-limited report for the remaining attempts.
    store.telegramReports=store.telegramReports.slice(0,1);
    for(let i=0;i<4;i++){store.telegramReports[0].nextAt=0;await flushTelegramReports();}
    expect(store.telegramReports[0].status).toBe('failed');await flushTelegramReports();expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('uses a timeout and records malformed responses as failures',async()=>{
    vi.useFakeTimers();await connect();
    fetchMock.mockImplementationOnce(async(_url:any,options:any)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')))));
    const attempt=expect(testTelegram()).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(8000);await attempt;
    fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>{throw new Error('not json');}});
    await expect(testTelegram()).rejects.toThrow('unreadable');
  });
  it('never retries invalid credentials and clears pending reports when the recipient changes or disconnects',async()=>{
    await connect();await queueTelegramState(confirmed());fetchMock.mockResolvedValueOnce(response(401,{ok:false,error_code:401}));
    await flushTelegramReports();await flushTelegramReports();expect(fetchMock).toHaveBeenCalledTimes(1);expect(store.telegramReports[0].status).toBe('failed');
    await saveTelegramSettings(true,'','987654321');expect(store.telegramReports).toEqual([]);
    await disconnectTelegram();expect(store.telegramConfig.botToken).toBe('');expect(await getTelegramSettings()).toMatchObject({enabled:false,hasToken:false,pending:0});
  });
});
