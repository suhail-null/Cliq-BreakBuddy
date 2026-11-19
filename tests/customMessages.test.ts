import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CLIQ_PROFILE,defaultState} from '../src/config';
import {customCommand,readCustom,recoverCustom,CUSTOM_ALARM} from '../src/services/customMessages';
import {inspect,sendMessage} from '../src/services/cliqMessenger';
import {notify} from '../src/services/reminderManager';
vi.mock('../src/services/cliqMessenger',()=>({inspect:vi.fn(),sendMessage:vi.fn()}));
vi.mock('../src/services/reminderManager',()=>({notify:vi.fn()}));
let store:Record<string,any>;let api:any;
const url='https://cliq.zoho.com/company/717321507/chats/CT_report';
const schedule=()=>customCommand({type:'SCHEDULE_CUSTOM',text:'DSR\nCompleted the report.\n\nNext: review.',url,name:'Reports',scheduledAt:Date.now()+60_000},CLIQ_PROFILE);
beforeEach(()=>{
  store={state:{...defaultState(),status:'BACK_PENDING',backPending:true,productionEnabled:true}};
  api={storage:{local:{get:vi.fn(async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(store[k])]))),set:vi.fn(async(data:any)=>Object.assign(store,structuredClone(data)))}},alarms:{get:vi.fn(),create:vi.fn(),clear:vi.fn()}};
  vi.stubGlobal('chrome',api);vi.mocked(inspect).mockResolvedValue({ok:true});vi.mocked(sendMessage).mockImplementation(async op=>({id:op.id,outcome:'confirmed',detail:'Confirmed',at:Date.now()}));vi.mocked(notify).mockResolvedValue(undefined);
  vi.clearAllMocks();
});
describe('independent custom message schedules',()=>{
  it('does not postpone an already armed deadline during repeated read-only recovery',async()=>{
    await schedule();const scheduledTime=store.customJobs[0].scheduledAt;api.alarms.get.mockResolvedValue({scheduledTime});api.alarms.create.mockClear();
    await recoverCustom(false);await recoverCustom(false);expect(api.alarms.create).not.toHaveBeenCalled();
    store.customJobs[0].scheduledAt=Date.now()-100;api.alarms.get.mockResolvedValue({scheduledTime:Date.now()+500});
    await recoverCustom(false);await recoverCustom(false);expect(api.alarms.create).not.toHaveBeenCalled();expect(sendMessage).not.toHaveBeenCalled();
  });
  it('rejects a send time that expires while Cliq is being checked',async()=>{
    const start=Date.now();const now=vi.spyOn(Date,'now').mockReturnValue(start);
    try {
      vi.mocked(inspect).mockImplementationOnce(async()=>{now.mockReturnValue(start+61_000);return{ok:true};});
      await expect(schedule()).rejects.toThrow('time passed while Cliq was loading');expect(store.customJobs).toBeUndefined();expect(sendMessage).not.toHaveBeenCalled();
    }finally{now.mockRestore();}
  });
  it('sends two due reports once each to their captured destinations even after saved entries change',async()=>{
    await schedule();await customCommand({type:'SCHEDULE_CUSTOM',text:'Second report',url:url+'2',name:'Second team',scheduledAt:Date.now()+60_000},CLIQ_PROFILE);
    await customCommand({type:'REMOVE_DESTINATION',url},CLIQ_PROFILE);store.state.profile.send='@cliq-shift-enter';
    for(const job of store.customJobs)job.scheduledAt=Date.now()-100;
    await recoverCustom(true);await recoverCustom(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);expect(vi.mocked(sendMessage).mock.calls.map(([op])=>op.destination?.name).sort()).toEqual(['Reports','Second team']);
    expect(vi.mocked(sendMessage).mock.calls.every(([,profile])=>profile.send===CLIQ_PROFILE.send)).toBe(true);expect(store.state.backPending).toBe(true);
  });
  it('persists a destination, multiline message and profile snapshot without changing Break/Back',async()=>{
    const before=structuredClone(store.state);const data=await schedule();
    expect(data.jobs[0].text).toBe('DSR\nCompleted the report.\n\nNext: review.');expect(data.jobs[0].profile).toEqual(CLIQ_PROFILE);
    expect(data.destinations[0].name).toBe('Reports');expect(store.state).toEqual(before);
    expect(api.alarms.create).toHaveBeenCalledWith(CUSTOM_ALARM,{when:data.jobs[0].scheduledAt});expect(sendMessage).not.toHaveBeenCalled();
  });
  it('sends once from a due alarm with no Back state or reminder changes',async()=>{
    await schedule();store.customJobs[0].scheduledAt=Date.now()-100;
    const before=structuredClone(store.state);await recoverCustom(true);await recoverCustom(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);expect(store.customJobs[0].status).toBe('sent');expect(store.state).toEqual(before);
    expect(vi.mocked(sendMessage).mock.calls[0][0]).toMatchObject({kind:'custom',group:'custom',text:'DSR\nCompleted the report.\n\nNext: review.'});
  });
  it('retains multiple separate destinations and removes only the selected saved entry',async()=>{
    await schedule();await customCommand({type:'SAVE_DESTINATION',url:url+'2',name:'Second team'},CLIQ_PROFILE);
    expect((await readCustom()).destinations).toHaveLength(2);
    await customCommand({type:'REMOVE_DESTINATION',url},CLIQ_PROFILE);
    expect((await readCustom()).destinations.map(d=>d.name)).toEqual(['Second team']);expect(store.customJobs[0].destination.name).toBe('Reports');
  });
  it('cancels a scheduled message without sending or cancelling a break',async()=>{
    const data=await schedule();await customCommand({type:'CUSTOM_ACTION',id:data.jobs[0].id,action:'cancel'},CLIQ_PROFILE);
    await recoverCustom(true);expect(store.customJobs[0].status).toBe('cancelled');expect(sendMessage).not.toHaveBeenCalled();expect(store.state.backPending).toBe(true);
  });
  it('requires Send now for a schedule missed during restart',async()=>{
    await schedule();store.customJobs[0].scheduledAt=Date.now()-100;await recoverCustom(true,true);
    expect(store.customJobs[0].status).toBe('overdue');expect(sendMessage).not.toHaveBeenCalled();
    await customCommand({type:'CUSTOM_ACTION',id:store.customJobs[0].id,action:'send'},CLIQ_PROFILE);expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('does not retry uncertain sends and requires an acknowledged review after 90 seconds',async()=>{
    vi.mocked(sendMessage).mockImplementation(async op=>({id:op.id,outcome:'uncertain',detail:'Not verified',at:Date.now()}));
    await schedule();store.customJobs[0].scheduledAt=Date.now()-100;await recoverCustom(true);const id=store.customJobs[0].id;
    await expect(customCommand({type:'CUSTOM_ACTION',id,action:'retry'},CLIQ_PROFILE)).rejects.toThrow();
    await expect(customCommand({type:'CUSTOM_ACTION',id,action:'resolve',checked:true,delivered:false},CLIQ_PROFILE)).rejects.toThrow('90 seconds');
    store.customJobs[0].operation.startedAt-=91_000;
    await customCommand({type:'CUSTOM_ACTION',id,action:'resolve',checked:true,delivered:false},CLIQ_PROFILE);
    expect(store.customJobs[0].status).toBe('failed');expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('restores an interrupted operation from its receipt without sending again',async()=>{
    await schedule();const job=store.customJobs[0];job.status='sending';job.operation={id:'lost',kind:'custom',text:job.text,group:'custom',destination:job.destination,startedAt:Date.now()};
    store['receipt:lost']={id:'lost',outcome:'confirmed',detail:'Verified',at:Date.now()};await recoverCustom(true);
    expect(store.customJobs[0].status).toBe('sent');expect(sendMessage).not.toHaveBeenCalled();
  });
  it('keeps a draft separately and rejects blank messages and past deadlines',async()=>{
    const draft={text:'My draft',name:'Reports',url,minutes:5};await customCommand({type:'SAVE_CUSTOM_DRAFT',draft},CLIQ_PROFILE);
    expect((await readCustom()).draft.text).toBe('My draft');expect(store.customJobs).toBeUndefined();
    await expect(customCommand({type:'SCHEDULE_CUSTOM',text:' ',url,name:'Reports',scheduledAt:Date.now()+60_000},CLIQ_PROFILE)).rejects.toThrow('Enter a message');
    await expect(customCommand({type:'SCHEDULE_CUSTOM',text:'DSR',url,name:'Reports',scheduledAt:Date.now()-1},CLIQ_PROFILE)).rejects.toThrow('future');
  });
});
