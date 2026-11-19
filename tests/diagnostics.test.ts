import {beforeEach,describe,expect,it,vi} from 'vitest';
import {inspectCliq} from '../src/content/diagnostics';
import {GROUPS} from '../src/config';
beforeEach(()=>{
  vi.stubGlobal('CSS',{escape:(value:string)=>value});
  vi.spyOn(Element.prototype,'getClientRects').mockReturnValue([{}] as any);
  document.body.innerHTML=`<section id="chat" data-chatid="${GROUPS.test.id}"><h2 id="title">Retired destination</h2><div class="messages"><div class="msg" data-message-id="secret-id" data-private="secret-value"><p>private chat message</p></div></div><div class="composer"><div id="composer-19-editor" class="ProseMirror" contenteditable="true">private draft text</div><div class="send-icon" title="Send">send</div></div></section>`;
});
describe('read-only Cliq diagnostics',()=>{
  it('discovers the reported ProseMirror editor and exact chat identity',()=>{
    const report=inspectCliq('test');
    expect(report.suggestions.editor).toBe('.ProseMirror[contenteditable="true"]');
    expect(report.suggestions.root).toBe('#chat');expect(report.suggestions.chatIdAttribute).toBe('data-chatid');expect(report.suggestions.header).toBe('#title');
    expect(report.missing).toContain('acknowledged');expect(report.missing).toContain('send');
  });
  it('includes non-button send controls without reading chat text or private attributes',()=>{
    const report=inspectCliq('test');const json=JSON.stringify(report);
    expect(report.controls.some(c=>c.classes==='send-icon')).toBe(true);
    expect(json).not.toContain('private chat message');expect(json).not.toContain('private draft text');expect(json).not.toContain('secret-value');
    expect(report.outline.some(n=>n.attributeNames.includes('data-message-id'))).toBe(true);
  });
  it('does not invent a chat identity when it is unavailable',()=>{
    document.querySelector('#chat')!.removeAttribute('data-chatid');
    const report=inspectCliq('test');expect(report.suggestions.root).toBeUndefined();expect(report.missing).toContain('root');
  });
  it('refuses diagnostics against a different selected destination',()=>expect(()=>inspectCliq('production')).toThrow('selected destination'));
  it('does not choose among multiple visible editors',()=>{
    document.querySelector('.composer')!.insertAdjacentHTML('beforeend','<textarea></textarea>');expect(inspectCliq('test').suggestions.editor).toBeUndefined();
  });
  it('captures hidden send descendants and UI action tokens inside the composer',()=>{
    const composer=document.querySelector('.composer')!;
    composer.setAttribute('composer-component','');
    composer.insertAdjacentHTML('beforeend','<section class="bottommenubar-sendsection"><div style="display:none" class="deep-send" data-action="sendMessage"><span>private control text</span></div></section>');
    const report=inspectCliq('test');
    expect(report.diagnosticsVersion).toBe(3);
    expect(report.focused.composer.find(node=>node.classes==='deep-send')?.controlValues['data-action']).toBe('sendMessage');
    expect(JSON.stringify(report)).not.toContain('private control text');
  });
  it('captures message descendants and ack tokens without guessing delivery status',()=>{
    document.querySelector('.messages')!.insertAdjacentHTML('beforeend','<div class="msgtxt me" mymsg="" msguid="123" id="message-123" ack="2" mode="live"><div><div><p class="body">private message body</p><i class="ack-marker"></i></div></div></div>');
    const report=inspectCliq('test');
    expect(report.suggestions.row).toBe('.msgtxt[msguid][id]');
    expect(report.suggestions.rowIdAttribute).toBe('msguid');
    expect(report.suggestions.own).toBe('.msgtxt.me[mymsg]');
    expect(report.suggestions.acknowledged).toBeUndefined();
    expect(report.focused.messageSamples[0].row.controlValues.ack).toBe('2');
    expect(report.focused.messageSamples[0].nodes.some(node=>node.classes==='ack-marker')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private message body');
  });
  it('does not let SVG icon libraries exhaust the capture before the Send section',()=>{
    const composer=document.querySelector('.composer')!;composer.setAttribute('composer-component','');
    composer.insertAdjacentHTML('afterbegin',`<div><svg>${'<symbol><path></path><circle></circle></symbol>'.repeat(350)}</svg></div>`);
    composer.insertAdjacentHTML('beforeend','<section class="bottommenubar-sendsection"><div class="send-control" data-action="sendMessage"></div></section>');
    const report=inspectCliq('test');
    expect(report.focused.sendSection.some(node=>node.controlValues['data-action']==='sendMessage')).toBe(true);
    expect(report.focused.composer.some(node=>node.classes==='send-control')).toBe(true);
    expect(report.focused.composer.some(node=>node.tag.toLowerCase()==='path')).toBe(false);
  });
  it('suggests the observed direct message body and omits deleted own samples',()=>{
    document.querySelector('.messages')!.insertAdjacentHTML('beforeend','<div class="msgtxt me dltinfomsg" mymsg="" msguid="1" id="deleted"><pre class="zcmsgcnt">deleted</pre></div><div class="msgtxt me" mymsg="" msguid="2" id="plain"><pre class="zcmsgcnt">private sample</pre></div>');
    const report=inspectCliq('test');
    expect(report.suggestions.body).toBe(':scope > pre.zcmsgcnt');
    expect(report.focused.messageSamples.map(sample=>sample.row.id)).toEqual(['plain']);
    expect(JSON.stringify(report)).not.toContain('private sample');
  });
});
