import {beforeEach,describe,expect,it,vi} from 'vitest';
import {confirmedRow,draft,hasDraft,messageIds,plainText,validate,waitFor,waitForDestination} from '../src/content/adapter';
import {GROUPS,groupUrl,isGroupUrl,parseCustomDestination} from '../src/config';
import type {Profile} from '../src/types';
const p:Profile={root:'#chat',chatIdAttribute:'data-chat',header:'.title',editor:'textarea',send:'.send',row:'.row',rowIdAttribute:'data-id',body:'.body',own:'.own',acknowledged:'.sent'};
function row(id:string,text:string,own=true,sent=true) {return `<div class="row ${own?'own':''}" data-id="${id}"><div class="body">${text}</div>${sent?'<i class="sent"></i>':''}</div>`;}
beforeEach(()=>{
  document.body.innerHTML=`<section id="chat" data-chat="${GROUPS.test.id}"><h2 class="title">Retired destination</h2><div class="messages">${row('old','Break')}</div><textarea></textarea><button class="send">Send</button></section>`;
  vi.spyOn(Element.prototype,'getClientRects').mockReturnValue([{}] as any);
});
describe('destination and draft protection',()=>{
  it('preserves DSR line breaks and blank paragraphs when reading ProseMirror and sent bodies',()=>{
    const el=document.createElement('div');el.innerHTML='<p>DSR</p><p>Completed</p><p><br></p><p>Next: review</p>';
    expect(draft(el)).toBe('DSR\nCompleted\n\nNext: review');
    el.innerHTML='DSR<br>Completed<br><br>Next: review';expect(plainText(el)).toBe('DSR\nCompleted\n\nNext: review');
  });
  it('waits for a selected conversation to render after the document has loaded',async()=>{
    const chat=document.querySelector('#chat')!;chat.remove();
    const pending=waitForDestination(p,'test');
    document.body.append(chat);
    expect((await pending).root.id).toBe('chat');
  });
  it('waits for the expected chat identity instead of accepting a stale view',async()=>{
    const chat=document.querySelector('#chat')!;chat.setAttribute('data-chat',GROUPS.production.id);
    const pending=waitForDestination(p,'test');
    chat.setAttribute('data-chat',GROUPS.test.id);
    expect((await pending).root.getAttribute('data-chat')).toBe(GROUPS.test.id);
  });
  it('parses a custom destination and checks its exact URL and title',()=>{
    const custom=parseCustomDestination('https://cliq.zoho.com/company/717321507/chats/CT_example/','Team room');
    expect(custom.id).toBe('CT_example');
    expect(isGroupUrl(custom.url,'custom',custom)).toBe(true);
    document.querySelector('#chat')!.setAttribute('data-chat',custom.id);document.querySelector('.title')!.textContent='Team room';
    expect(validate(p,'custom',custom.url,custom).editor.tagName).toBe('TEXTAREA');
    expect(()=>validate(p,'custom',groupUrl('test'),custom)).toThrow('URL');
  });
  it.each(['https://evil.example/company/717321507/chats/test','https://cliq.zoho.com/company/123/chats/test','https://cliq.zoho.com/company/717321507/index.do','https://cliq.zoho.com/company/717321507/chats/test?redirect=1'])('rejects unsupported custom links: %s',url=>expect(()=>parseCustomDestination(url,'Team')).toThrow());
  it('requires the exact company and conversation URL',()=>{
    expect(isGroupUrl(groupUrl('test'),'test')).toBe(true);
    expect(isGroupUrl(groupUrl('production'),'test')).toBe(false);
    expect(isGroupUrl(`${groupUrl('test')}/another`,'test')).toBe(false);
    expect(isGroupUrl(groupUrl('test').replace('cliq.zoho.com','evil.example'),'test')).toBe(false);
  });
  it('validates chat identity, header, and editor',()=>expect(validate(p,'test',groupUrl('test')).editor.tagName).toBe('TEXTAREA'));
  it('fails if route is correct but stale chat is still displayed',()=>{document.querySelector('#chat')!.setAttribute('data-chat',GROUPS.production.id);expect(()=>validate(p,'test',groupUrl('test'))).toThrow('identity');});
  it('rejects a mismatched chat title',()=>{document.querySelector('.title')!.textContent='MarTech';expect(()=>validate(p,'test',groupUrl('test'))).toThrow('title');});
  it('refuses missing or ambiguous editors',()=>{document.querySelector('#chat')!.append(document.createElement('textarea'));expect(()=>validate(p,'test',groupUrl('test'))).toThrow('found 2');});
  it('detects a typed draft without changing it',()=>{const e=document.querySelector('textarea')!;e.value='my unfinished message';expect(hasDraft(e)).toBe(true);expect(e.value).toBe('my unfinished message');});
  it('requires configured selectors',()=>expect(()=>validate({...p,root:''},'test',groupUrl('test'))).toThrow('Setup incomplete: root'));
});
describe('send confirmation',()=>{
  it.each(['pending','sending','failed','dltinfomsg'])('excludes %s rows from fresh-view confirmation',status=>{
    const root=document.querySelector<HTMLElement>('#chat')!;
    root.insertAdjacentHTML('beforeend',`<div id="1793604475482_123" class="row own ${status}" data-id="new" chid="${GROUPS.test.id}"><div class="body">Back</div></div>`);
    expect(confirmedRow(root,{...p,acknowledged:'@fresh-chat'},'Back',new Set())).toBeNull();
  });
  it('requires the message row chat ID to match the verified container',()=>{
    const root=document.querySelector<HTMLElement>('#chat')!;
    root.insertAdjacentHTML('beforeend',`<div id="1793604475482_123" class="row own" data-id="new" chid="${GROUPS.production.id}"><div class="body">Back</div></div>`);
    expect(confirmedRow(root,{...p,acknowledged:'@fresh-chat'},'Back',new Set())).toBeNull();
  });
  it('ignores an older identical message',()=>{const root=document.querySelector<HTMLElement>('#chat')!;expect(confirmedRow(root,p,'Break',messageIds(root,p))).toBeNull();});
  it('requires a new ID, exact body, own row, and acknowledgement',()=>{const root=document.querySelector<HTMLElement>('#chat')!;const before=messageIds(root,p);root.insertAdjacentHTML('beforeend',row('new','Break'));expect(confirmedRow(root,p,'Break',before)).toBe('new');});
  it.each([[false,true],[true,false]])('does not accept another author or a pending row (%s,%s)',(own,sent)=>{const root=document.querySelector<HTMLElement>('#chat')!;const before=messageIds(root,p);root.insertAdjacentHTML('beforeend',row('new','Back',own,sent));expect(confirmedRow(root,p,'Back',before)).toBeNull();});
  it('does not accept ambiguous matching rows',()=>{const root=document.querySelector<HTMLElement>('#chat')!;root.insertAdjacentHTML('beforeend',row('a','Back')+row('b','Back'));expect(confirmedRow(root,p,'Back',new Set())).toBeNull();});
  it('waits for asynchronous UI acknowledgement',async()=>{const promise=waitFor(()=>document.querySelector('.late'));document.querySelector('#chat')!.insertAdjacentHTML('beforeend','<i class="late"></i>');expect(await promise).not.toBeNull();});
});
