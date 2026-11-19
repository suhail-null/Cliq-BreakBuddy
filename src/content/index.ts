import { destinationFor, isGroupUrl } from '../config';
import { confirmedRow, draft, hasDraft, messageIds, unique, validate, waitFor, waitForDestination } from './adapter';
import type { Operation, Profile, Receipt } from '../types';
import {inspectCliq} from './diagnostics';

// Reinjection on an already-open Cliq page must not register a second sender.
const global = globalThis as typeof globalThis & { __breakBuddyInstalled?: boolean };
if(!global.__breakBuddyInstalled) {
  global.__breakBuddyInstalled=true;
  let busy=false;
  async function submit(op: Operation, profile: Profile): Promise<Receipt> {
    const key=`receipt:${op.id}`;
    const previous = (await chrome.storage.local.get(key))[key] as Receipt | undefined;
    if(previous) return previous;
    if(busy) return {id:op.id,outcome:'failed',detail:'Another submission is still in progress.',at:Date.now()};
    busy=true;
    let touched=false;
    const persist=async(r:Receipt)=>{await chrome.storage.local.set({[key]:r}); return r;};
    try {
      if(typeof op.text!=='string'||!op.text.trim()||op.text.length>20_000||!['test','production','custom'].includes(op.group)) throw new Error('Unsupported message or group.');
      if(op.kind==='custom') {
        const {customJobs}=await chrome.storage.local.get('customJobs');
        const job=customJobs?.find((j:any)=>j.status==='sending' && j.operation?.id===op.id);
        if(!job || JSON.stringify(job.operation)!==JSON.stringify(op) || JSON.stringify(job.profile)!==JSON.stringify(profile) || job.text!==op.text || JSON.stringify(job.destination)!==JSON.stringify(op.destination)) throw new Error('This custom message is no longer authorized.');
      } else {
        if(!['Break','Back'].includes(op.text)) throw new Error('Unsupported break message.');
        const {state}=await chrome.storage.local.get('state');
        if(state?.operation?.id!==op.id || state.operation.text!==op.text || state.group!==op.group || (op.group!=='test' && !state.productionEnabled)) throw new Error('This send is no longer authorized by the extension.');
        if(op.group==='custom' && JSON.stringify(destinationFor('custom',state.customDestination))!==JSON.stringify(destinationFor('custom',op.destination))) throw new Error('Custom destination changed since this operation was authorized.');
      }
      let view: ReturnType<typeof validate>;
      await waitFor(()=>{try {view=validate(profile,op.group,location.href,op.destination); return true;} catch {return null;}},10_000).catch(()=>{validate(profile,op.group,location.href,op.destination);});
      view=validate(profile,op.group,location.href,op.destination);
      const {root,editor}=view;
      if(hasDraft(editor)) throw new Error('The target editor already contains a draft. It was preserved. Clear or send it yourself before retrying.');
      const before=messageIds(root,profile);
      // Durable intent precedes insertion/click. Any interruption from this point is uncertain.
      await persist({id:op.id,outcome:'uncertain',detail:'Submission started; confirmation has not been received.',at:Date.now()});
      // Revalidate after asynchronous storage access and immediately before synchronous DOM mutation.
      const again=validate(profile,op.group,location.href,op.destination);
      if(again.root!==root || again.editor!==editor || hasDraft(editor)) throw new Error('The chat or draft changed before insertion.');
      touched=true;
      if(editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        const prototype=editor instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(editor,op.text);
      } else {
        if(op.text.includes('\n')) {
          const paragraphs=op.text.split('\n').map(line=>{const p=document.createElement('p');p.append(line?document.createTextNode(line):document.createElement('br'));return p;});
          editor.replaceChildren(...paragraphs);
        } else editor.replaceChildren(document.createTextNode(op.text));
      }
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:op.text}));
      // Yield to the ProseMirror mutation observer before dispatching its keyboard handler.
      await chrome.storage.local.get(key);
      const keyboard=profile.send==='@cliq-enter' || profile.send==='@cliq-shift-enter';
      const button=keyboard ? null : await waitFor(()=>{
        validate(profile,op.group,location.href,op.destination);
        try {const b=unique(root,profile.send); return b.matches(':disabled') || b.getAttribute('aria-disabled')==='true' ? null : b;} catch {return null;}
      },3000);
      const finalView=validate(profile,op.group,location.href,op.destination);
      if(finalView.editor!==editor || finalView.root!==root || draft(editor).trim()!==op.text || (button && (!button.isConnected || !root.contains(button)))) throw new Error('Chat or draft changed before Send. Check Cliq.');
      if(keyboard) {
        const init={key:'Enter',code:'Enter',keyCode:13,which:13,shiftKey:profile.send==='@cliq-shift-enter',bubbles:true,cancelable:true};
        editor.dispatchEvent(new KeyboardEvent('keydown',init));
        editor.dispatchEvent(new KeyboardEvent('keyup',init));
      } else button!.click();
      const messageId=await waitFor(()=>{
        if(!isGroupUrl(location.href,op.group,op.destination)) throw new Error('Conversation changed while confirming submission.');
        const current=validate(profile,op.group,location.href,op.destination);
        if(current.root!==root) throw new Error('Chat view changed while confirming submission.');
        if(hasDraft(editor)) return null;
        return confirmedRow(root,profile,op.text,before);
      });
      const fresh=profile.acknowledged==='@fresh-chat';
      return await persist({id:op.id,outcome:fresh?'uncertain':'confirmed',detail:fresh?'New own message observed; a fresh Cliq view must verify persistence.':'New own message with sent acknowledgement found in the target chat.',messageId,at:Date.now()});
    } catch(error) {
      return await persist({id:op.id,outcome:touched?'uncertain':'failed',detail:error instanceof Error?error.message:String(error),at:Date.now()});
    } finally {busy=false;}
  }
  chrome.runtime.onMessage.addListener((msg:any,sender:any,respond:any)=>{
    if(sender.id!==chrome.runtime.id) return false;
    if(msg.type==='BB_PING') {respond({ok:true});return false;}
    if(msg.type==='BB_READY') {
      void waitForDestination(msg.profile,msg.group,msg.destination)
        .then(({editor})=>respond({ok:true,emptyEditor:!hasDraft(editor)}),error=>respond({ok:false,error:(error as Error).message}));
      return true;
    }
    if(msg.type==='BB_SEND') {void submit(msg.operation,msg.profile).then(respond,error=>respond({id:msg.operation.id,outcome:'uncertain',detail:String(error),at:Date.now()}));return true;}
    if(msg.type==='BB_VERIFY') {
      void waitFor(()=>{
        let view: ReturnType<typeof validate>;
        try {view=validate(msg.profile,msg.operation.group,location.href,msg.operation.destination);} catch {return null;}
        const before=messageIds(view.root,msg.profile);before.delete(msg.messageId);
        const id=confirmedRow(view.root,msg.profile,msg.operation.text,before);
        return id===msg.messageId?{ok:true,messageId:id,emptyEditor:!hasDraft(view.editor)}:null;
      }).then(respond,error=>respond({ok:false,error:(error as Error).message}));return true;
    }
    if(msg.type==='BB_CHECK') {
      void waitForDestination(msg.profile,msg.group,msg.destination).then(({root,editor})=>{
        if(hasDraft(editor)) {respond({ok:false,error:'The editor has an existing draft. It was preserved.'});return;}
        respond({ok:true,detail:'Destination and empty editor verified. No message was sent. The built-in profile verifies actual sends in a fresh Cliq tab.',rows:root.querySelectorAll(msg.profile.row).length});
      },error=>respond({ok:false,error:(error as Error).message}));return true;
    }
    if(msg.type==='BB_INSPECT') {
      try {respond(inspectCliq(msg.group,msg.destination));}
      catch(error) {respond({ok:false,error:(error as Error).message});} return false;
    }
    return false;
  });
}
