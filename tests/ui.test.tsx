import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {App} from '../src/popup/App';
import {defaultState} from '../src/config';
import type {State} from '../src/types';
let root:Root;let box:HTMLDivElement;let api:any;let current:State;let changeListener:any;
const customData={jobs:[],destinations:[{name:'Reports',id:'CT_reports',url:'https://cliq.zoho.com/company/717321507/chats/CT_reports'}],draft:{text:'DSR\nCompleted the work',url:'https://cliq.zoho.com/company/717321507/chats/CT_reports',name:'Reports',minutes:5,timing:'delay'}};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
beforeEach(()=>{
  current=defaultState();box=document.createElement('div');document.body.append(box);root=createRoot(box);
  api={runtime:{getURL:(p:string)=>`chrome-extension://test/${p}`,sendMessage:vi.fn(async(command:any)=>{
    if(command.type==='GET_CUSTOM'||command.type==='SCHEDULE_CUSTOM')return {ok:true,data:structuredClone(customData)};
    if(command.type==='SCHEDULE')current={...current,status:'BREAK_SCHEDULED',scheduledAt:Date.now()+command.minutes*60_000};
    if(command.type==='BACK')current={...current,status:'AVAILABLE',backPending:false};
    return {ok:true,data:current};
  })},storage:{onChanged:{addListener:vi.fn((listener:any)=>{changeListener=listener;}),removeListener:vi.fn()}},windows:{create:vi.fn()}};
  vi.stubGlobal('chrome',api);
});
afterEach(async()=>{await act(async()=>{root.unmount();});box.remove();vi.unstubAllGlobals();});
async function render(state:State=current){current=state;await act(async()=>{root.render(<App/>);});}
function button(text:string){const result=[...box.querySelectorAll('button')].find(b=>b.textContent?.includes(text));if(!result)throw new Error(`No button: ${text}`);return result;}
describe('side companion UI',()=>{
  it('places Custom Message last and preserves the selected date/time form and report text',async()=>{
    await render();expect([...box.querySelectorAll('nav button')].map(b=>b.textContent)).toEqual(['Today','Activity','Settings','Custom Message']);
    await act(async()=>{button('Custom Message').click();});
    await act(async()=>{box.querySelector<HTMLInputElement>('input[name="timing"][value="date"]')!.click();});
    expect(box.querySelector('#custom-date')).not.toBeNull();expect(box.querySelector('#custom-delay')).toBeNull();
    expect(box.querySelector<HTMLTextAreaElement>('#custom-text')!.value).toBe(customData.draft.text);
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({type:'SAVE_CUSTOM_DRAFT',draft:expect.objectContaining({timing:'date'})}));
  });
  it('loads Custom Message when navigation happens during another action',async()=>{
    await render();let finish!:(value:any)=>void;
    api.runtime.sendMessage.mockImplementation(async(command:any)=>command.type==='SCHEDULE'?new Promise(resolve=>{finish=resolve;}):{ok:true,data:structuredClone(customData)});
    await act(async()=>{box.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    await act(async()=>{button('Custom Message').click();});
    expect(box.querySelector('#custom-text')).not.toBeNull();expect(box.textContent).not.toContain('Getting your messages ready');
    await act(async()=>{finish({ok:true,data:current});});
  });
  it('provides recovery when loading saved messages fails',async()=>{
    await render();api.runtime.sendMessage.mockResolvedValueOnce({ok:false,error:'Connection interrupted'});
    await act(async()=>{button('Custom Message').click();});
    expect(box.querySelector('[role="alert"]')?.textContent).toContain('Connection interrupted');
    await act(async()=>{button('Try again').click();});expect(box.querySelector('#custom-text')).not.toBeNull();
  });
  it('keeps focus while editing a saved destination and preserves typed draft text during a queue refresh',async()=>{
    await render();await act(async()=>{button('Custom Message').click();});
    const details=box.querySelector<HTMLDetailsElement>('.destination-details')!;details.open=true;
    const url=box.querySelector<HTMLInputElement>('#custom-url')!;url.focus();
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(url,url.value+'2');url.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(document.activeElement).toBe(url);expect(box.querySelector('#custom-url')).toBe(url);
    const editor=box.querySelector<HTMLTextAreaElement>('#custom-text')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(editor,'My unscheduled edits');editor.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>{changeListener({customJobs:{newValue:[]}},'local');});
    expect(box.querySelector<HTMLTextAreaElement>('#custom-text')!.value).toBe('My unscheduled edits');
  });
  it('opens Custom Message and schedules its own report and destination without a Break command',async()=>{
    await render();await act(async()=>{button('Custom Message').click();});
    expect(document.activeElement?.textContent).toBe('Custom Message');expect(box.querySelector<HTMLTextAreaElement>('#custom-text')!.value).toBe('DSR\nCompleted the work');
    const before=Date.now();await act(async()=>{box.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    const commands=api.runtime.sendMessage.mock.calls.map(([c]:any)=>c);const scheduled=commands.find((c:any)=>c.type==='SCHEDULE_CUSTOM');
    expect(scheduled.text).toBe('DSR\nCompleted the work');expect(scheduled.name).toBe('Reports');expect(scheduled.scheduledAt).toBeGreaterThanOrEqual(before+5*60_000);
    expect(commands.some((c:any)=>c.type==='SCHEDULE'||c.type==='SAVE_CONFIG'||c.type==='BACK')).toBe(false);
  });
  it('offers MarTech and saved custom destinations without a personal test group',async()=>{
    await render();await act(async()=>{button('Settings').click();});
    const options=[...box.querySelectorAll('#destination option')].map(o=>o.textContent);
    expect(options).toContain('MarTech');expect(options).toContain('Reports · Custom');expect(options.some(o=>o?.includes('Retired')||o?.includes('2y'))).toBe(false);
  });
  it('allows a one-minute MarTech timer and exposes a large labelled custom stepper',async()=>{
    await render({...current,group:'production',productionEnabled:true});
    const input=box.querySelector<HTMLInputElement>('#break-minutes')!;
    expect(input.min).toBe('1');expect(input.hasAttribute('max')).toBe(false);
    expect(box.querySelector('[aria-label="Increase minutes"]')).not.toBeNull();
    await act(async()=>{box.querySelector<HTMLButtonElement>('.presets button')!.click();});
    for(let i=0;i<4;i++) await act(async()=>{box.querySelector<HTMLButtonElement>('[aria-label="Decrease minutes"]')!.click();});
    expect(input.value).toBe('1');expect(box.querySelector<HTMLButtonElement>('[aria-label="Decrease minutes"]')!.disabled).toBe(true);
    await act(async()=>{box.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({type:'SCHEDULE',minutes:1});
  });
  it('offers six presets and schedules the selected duration through the background command',async()=>{
    await render();
    expect([...box.querySelectorAll('.presets button > span:first-child')].map(n=>Number(n.textContent))).toEqual([5,10,15,20,25,30]);
    await act(async()=>{box.querySelector<HTMLButtonElement>('.presets button')!.click();});
    await act(async()=>{box.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({type:'SCHEDULE',minutes:5});expect(box.textContent).toContain('Break scheduled');
  });
  it('keeps a prominent Back action and sends Back only after clicking it',async()=>{
    await render({...current,status:'BACK_PENDING',backPending:true,breakSentAt:Date.now()});
    expect(box.querySelector('.is-pending')).not.toBeNull();expect(api.runtime.sendMessage.mock.calls.some(([c]:any)=>c.type==='BACK')).toBe(false);
    await act(async()=>{button('I’m Back').click();});
    expect(api.runtime.sendMessage.mock.calls.filter(([c]:any)=>c.type==='BACK')).toHaveLength(1);
  });
  it('restores pending status from storage changes without sending a message',async()=>{
    await render();await act(async()=>{changeListener({state:{newValue:{...current,status:'BACK_PENDING',backPending:true}}},'local');});
    expect(box.textContent).toContain('Back at your desk?');expect(api.runtime.sendMessage.mock.calls.some(([c]:any)=>c.type==='BACK')).toBe(false);
  });
  it('moves focus to the new view heading and keeps a return reminder visible in Settings',async()=>{
    await render({...current,status:'BACK_PENDING',backPending:true});
    await act(async()=>{button('Settings').click();});
    expect(document.activeElement?.textContent).toBe('Your preferences');expect(box.querySelector('.return-banner')).not.toBeNull();
    expect(box.querySelector<HTMLSelectElement>('#destination')!.disabled).toBe(true);
  });
  it('requires the existing manual-review acknowledgement before resolving an uncertain send',async()=>{
    await render({...current,status:'UNCERTAIN',backPending:true,operation:{id:'uncertain',text:'Back',group:'test',startedAt:Date.now()}});
    expect(button('It was sent').disabled).toBe(true);expect(box.textContent).not.toContain('I’m Back — Send Back');
    await act(async()=>{box.querySelector<HTMLInputElement>('#message-checked')!.click();});
    await act(async()=>{button('It was sent').click();});
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({type:'RESOLVE',delivered:true,checked:true});
  });
});
