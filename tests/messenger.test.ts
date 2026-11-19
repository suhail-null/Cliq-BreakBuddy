import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CLIQ_PROFILE,groupUrl} from '../src/config';
import {inspect,sendMessage} from '../src/services/cliqMessenger';
import type {Operation} from '../src/types';
const op:Operation={id:'attempt',text:'Break',group:'test',startedAt:Date.now()};
let api:any;let confirmed=true;
beforeEach(()=>{
  confirmed=true;
  let nextTab=2;
  api={tabs:{query:vi.fn(async()=>[{id:1,url:groupUrl('test')}]),get:vi.fn(async()=>({status:'complete'})),create:vi.fn(async()=>({id:nextTab++})),sendMessage:vi.fn(async(id:number,msg:any)=>{
    if(msg.type==='BB_PING' || msg.type==='BB_READY' || msg.type==='BB_CHECK')return {ok:true};
    if(msg.type==='BB_SEND')return {id:op.id,outcome:'uncertain',messageId:'stable-id',detail:'locally observed',at:Date.now()};
    if(msg.type==='BB_VERIFY')return {ok:confirmed,messageId:confirmed?'stable-id':undefined};
  })},storage:{local:{set:vi.fn()}},scripting:{executeScript:vi.fn()}};
  vi.stubGlobal('chrome',api);
});
describe('independent UI confirmation',()=>{
  it('confirms only after the exact message is found in a fresh tab',async()=>{
    const receipt=await sendMessage(op,CLIQ_PROFILE);
    expect(receipt.outcome).toBe('confirmed');expect(api.tabs.create).toHaveBeenCalledWith({url:groupUrl('test'),active:false});
    expect(api.tabs.sendMessage.mock.calls.filter(([,msg]:any)=>msg.type==='BB_SEND')).toHaveLength(1);
    expect(api.tabs.sendMessage.mock.calls.find(([,msg]:any)=>msg.type==='BB_VERIFY')[0]).toBe(2);
    expect(api.storage.local.set).toHaveBeenCalledWith({'receipt:attempt':receipt});
  });
  it('keeps a locally observed message uncertain when the fresh view cannot confirm it',async()=>{
    confirmed=false;expect((await sendMessage(op,CLIQ_PROFILE)).outcome).toBe('uncertain');expect(api.storage.local.set).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage.mock.calls.filter(([,msg]:any)=>msg.type==='BB_SEND')).toHaveLength(1);
  });
  it('does not claim success or retry when verification navigation fails',async()=>{
    api.tabs.create.mockRejectedValue(new Error('Cliq unavailable'));
    expect((await sendMessage(op,CLIQ_PROFILE)).outcome).toBe('uncertain');
    expect(api.tabs.sendMessage.mock.calls.filter(([,msg]:any)=>msg.type==='BB_SEND')).toHaveLength(1);
  });
  it('opens the destination in an inactive tab when no Cliq tab exists',async()=>{
    api.tabs.query.mockResolvedValue([]);
    const receipt=await sendMessage(op,CLIQ_PROFILE);
    expect(receipt.outcome).toBe('confirmed');
    const sent=api.tabs.sendMessage.mock.calls.find(([,msg]:any)=>msg.type==='BB_SEND');
    expect(sent[0]).toBe(2);
    expect(api.tabs.create.mock.calls.every(([options]:any)=>options.url===groupUrl('test') && options.active===false)).toBe(true);
  });
  it('opens the destination without navigating an existing different conversation',async()=>{
    api.tabs.query.mockResolvedValue([{id:1,url:groupUrl('production')}]);
    expect((await sendMessage(op,CLIQ_PROFILE)).outcome).toBe('confirmed');
    expect(api.tabs.sendMessage.mock.calls.find(([,msg]:any)=>msg.type==='BB_SEND')[0]).toBe(2);
    expect(api.tabs.sendMessage.mock.calls.some(([id,msg]:any)=>id===1 && msg.type==='BB_SEND')).toBe(false);
  });
  it('uses one new background tab if an existing matching URL has no ready chat',async()=>{
    const original=api.tabs.sendMessage.getMockImplementation();
    api.tabs.sendMessage.mockImplementation(async(id:number,msg:any)=>msg.type==='BB_READY' && id===1?{ok:false,error:'No visible selected chat.'}:original(id,msg));
    expect((await sendMessage(op,CLIQ_PROFILE)).outcome).toBe('confirmed');
    expect(api.tabs.sendMessage.mock.calls.filter(([,msg]:any)=>msg.type==='BB_SEND')).toHaveLength(1);
    expect(api.tabs.sendMessage.mock.calls.find(([,msg]:any)=>msg.type==='BB_SEND')[0]).toBe(2);
  });
  it('waits for SPA readiness before checking setup',async()=>{
    api.tabs.query.mockResolvedValue([]);
    let release:any;
    const readyPromise=new Promise(resolve=>{release=resolve;});
    const original=api.tabs.sendMessage.getMockImplementation();
    api.tabs.sendMessage.mockImplementation(async(id:number,msg:any)=>msg.type==='BB_READY'?readyPromise:original(id,msg));
    const pending=inspect('test',CLIQ_PROFILE,true);
    await vi.waitFor(()=>expect(api.tabs.sendMessage.mock.calls.some(([,msg]:any)=>msg.type==='BB_READY')).toBe(true));
    expect(api.tabs.sendMessage.mock.calls.some(([,msg]:any)=>msg.type==='BB_CHECK')).toBe(false);
    release({ok:true});expect((await pending).ok).toBe(true);
  });
  it('reports a definitive failure without sending when a newly opened Cliq tab cannot initialize',async()=>{
    api.tabs.query.mockResolvedValue([]);
    const original=api.tabs.sendMessage.getMockImplementation();
    api.tabs.sendMessage.mockImplementation(async(id:number,msg:any)=>msg.type==='BB_READY'?{ok:false,error:'Login expired.'}:original(id,msg));
    const receipt=await sendMessage(op,CLIQ_PROFILE);
    expect(receipt.outcome).toBe('failed');expect(receipt.detail).toContain('signed in');
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(api.tabs.sendMessage.mock.calls.some(([,msg]:any)=>msg.type==='BB_SEND')).toBe(false);
  });
  it('does not switch to another tab or retry after a send command has been issued',async()=>{
    const original=api.tabs.sendMessage.getMockImplementation();
    api.tabs.sendMessage.mockImplementation(async(id:number,msg:any)=>msg.type==='BB_SEND'?{id:op.id,outcome:'failed',detail:'Draft already present.',at:Date.now()}:original(id,msg));
    expect((await sendMessage(op,CLIQ_PROFILE)).outcome).toBe('failed');
    expect(api.tabs.create).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage.mock.calls.filter(([,msg]:any)=>msg.type==='BB_SEND')).toHaveLength(1);
  });
});
