import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {GROUPS} from '../src/config';
import type {Operation,Profile} from '../src/types';
const profile:Profile={root:'#chat',chatIdAttribute:'data-chat',header:'.title',editor:'textarea',send:'.send',row:'.row',rowIdAttribute:'data-id',body:'.body',own:'.own',acknowledged:'.sent'};
const op:Operation={id:'one-attempt',text:'Break',group:'test',startedAt:Date.now()};
let listener:any;let store:Record<string,any>;let click:any;let appendMessage=true;
async function submit(operation=op) {return new Promise<any>(resolve=>listener({type:'BB_SEND',operation,profile},{id:'test-extension'},resolve));}
beforeEach(async()=>{
  vi.resetModules();delete (globalThis as any).__breakBuddyInstalled;appendMessage=true;
  store={state:{operation:op,group:'test',productionEnabled:false}};
  vi.stubGlobal('chrome',{runtime:{id:'test-extension',onMessage:{addListener:(fn:any)=>{listener=fn;}}},storage:{local:{get:vi.fn(async(key:string)=>({[key]:structuredClone(store[key])})),set:vi.fn(async(update:any)=>Object.assign(store,structuredClone(update)))}}});
  vi.spyOn(Element.prototype,'getClientRects').mockReturnValue([{}] as any);
  document.body.innerHTML=`<section id="chat" data-chat="${GROUPS.test.id}"><h2 class="title">Retired destination</h2><div class="messages"></div><textarea></textarea><button class="send">Send</button></section>`;
  click=vi.fn(()=>{
    const editor=document.querySelector('textarea')!;
    if(appendMessage) {document.querySelector('.messages')!.insertAdjacentHTML('beforeend',`<div class="row own" data-id="sent-1"><div class="body">${editor.value}</div><i class="sent"></i></div>`);editor.value='';}
  });
  document.querySelector('button')!.addEventListener('click',click);
  await import('../src/content/index');
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('content-script submission',()=>{
  it('sends an independently authorized multiline custom report without a break operation',async()=>{
    const destination={id:GROUPS.test.id,name:GROUPS.test.name,url:location.href};
    const operation:Operation={...op,group:'custom',kind:'custom',destination,text:'DSR\nCompleted today\n\nNext: review'};
    store.state={operation:null,group:'production',productionEnabled:false};
    store.customJobs=[{status:'sending',operation,text:operation.text,destination,profile}];
    const result=await submit(operation);expect(result.outcome).toBe('confirmed');expect(click).toHaveBeenCalledTimes(1);expect(store.state.operation).toBeNull();
  });
  it('rejects a custom report with a forged text or no durable job',async()=>{
    const operation:Operation={...op,kind:'custom',text:'Forged report'};
    expect((await submit(operation)).outcome).toBe('failed');expect(click).not.toHaveBeenCalled();
    delete store['receipt:one-attempt'];store.customJobs=[{status:'sending',operation:{...operation,text:'Original'},profile}];
    expect((await submit(operation)).outcome).toBe('failed');expect(click).not.toHaveBeenCalled();
  });
  it('answers readiness only after the destination has rendered, without sending',async()=>{
    const chat=document.querySelector('#chat')!;chat.remove();
    const ready=new Promise<any>(resolve=>listener({type:'BB_READY',group:'test',profile},{id:'test-extension'},resolve));
    document.body.append(chat);
    expect((await ready).ok).toBe(true);expect(click).not.toHaveBeenCalled();
  });
  it('preserves a draft when a read-only setup check runs after readiness',async()=>{
    document.querySelector('textarea')!.value='my draft';
    const result=await new Promise<any>(resolve=>listener({type:'BB_CHECK',group:'test',profile},{id:'test-extension'},resolve));
    expect(result.ok).toBe(false);expect(document.querySelector('textarea')!.value).toBe('my draft');expect(click).not.toHaveBeenCalled();
  });
  it('uses Enter without clicking the send-settings control, then requests independent verification',async()=>{
    const editor=document.querySelector('textarea')!;
    editor.addEventListener('keydown',event=>{
      if(event.key==='Enter') {
        event.preventDefault();
        document.querySelector('.messages')!.insertAdjacentHTML('beforeend',`<div class="row own" id="1793604475482_123" data-id="keyboard-message" chid="${GROUPS.test.id}"><div class="body">${editor.value}</div></div>`);editor.value='';
      }
    });
    const p={...profile,send:'@cliq-enter',acknowledged:'@fresh-chat'};
    const result=await new Promise<any>(resolve=>listener({type:'BB_SEND',operation:op,profile:p},{id:'test-extension'},resolve));
    expect(result.outcome).toBe('uncertain');expect(result.messageId).toBe('keyboard-message');expect(click).not.toHaveBeenCalled();
    const proof=await new Promise<any>(resolve=>listener({type:'BB_VERIFY',operation:op,profile:p,messageId:result.messageId},{id:'test-extension'},resolve));
    expect(proof.ok).toBe(true);expect(proof.messageId).toBe('keyboard-message');
  });
  it('dispatches input, clicks Send, and records a confirmed receipt',async()=>{
    const input=vi.fn();document.querySelector('textarea')!.addEventListener('input',input);
    const result=await submit();expect(result.outcome).toBe('confirmed');expect(result.messageId).toBe('sent-1');expect(click).toHaveBeenCalledTimes(1);expect(input).toHaveBeenCalledTimes(1);expect(store['receipt:one-attempt'].outcome).toBe('confirmed');
  });
  it('returns a previous receipt without sending the operation twice',async()=>{
    await submit();const result=await submit();expect(result.outcome).toBe('confirmed');expect(click).toHaveBeenCalledTimes(1);
  });
  it('preserves an existing draft and returns a definite failure',async()=>{
    document.querySelector('textarea')!.value='unfinished user message';const result=await submit();expect(result.outcome).toBe('failed');expect(click).not.toHaveBeenCalled();expect(document.querySelector('textarea')!.value).toBe('unfinished user message');
  });
  it('does not accept a click alone as confirmation',async()=>{
    vi.useFakeTimers();appendMessage=false;const result=submit();await vi.advanceTimersByTimeAsync(15_100);expect((await result).outcome).toBe('uncertain');expect(store['receipt:one-attempt'].outcome).toBe('uncertain');expect(click).toHaveBeenCalledTimes(1);
  });
  it('blocks unapproved production operations before insertion',async()=>{
    const production={...op,group:'production' as const};store.state.operation=production;store.state.group='production';const result=await submit(production);expect(result.outcome).toBe('failed');expect(click).not.toHaveBeenCalled();expect(document.querySelector('textarea')!.value).toBe('');
  });
  it('rejects stale operation IDs',async()=>{store.state.operation={...op,id:'newer'};expect((await submit()).outcome).toBe('failed');expect(click).not.toHaveBeenCalled();});
  it('rejects a stale chat identity even when the URL is correct',async()=>{
    vi.useFakeTimers();document.querySelector('#chat')!.setAttribute('data-chat',GROUPS.production.id);const result=submit();await vi.advanceTimersByTimeAsync(10_100);expect((await result).outcome).toBe('failed');expect(click).not.toHaveBeenCalled();
  });
});
