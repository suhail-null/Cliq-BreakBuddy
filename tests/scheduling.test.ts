import {describe,expect,it,vi} from 'vitest';
import {defaultState} from '../src/config';
import {dueDecision,restoreAlarms,validMinutes} from '../src/services/breakScheduler';
import {complete} from '../src/background/machine';
import type {Operation,Receipt} from '../src/types';
const op:Operation={id:'attempt-1',text:'Break',group:'test',startedAt:1000};
const receipt:Receipt={id:op.id,outcome:'confirmed',detail:'UI confirmed',at:2000};
describe('scheduling and persistent state',()=>{
  it.each([10,20,30])('accepts %i minute schedules',m=>expect(validMinutes(m)).toBe(true));
  it.each([1,2,7,481,1440])('accepts any positive whole duration %i for all destinations',m=>expect(validMinutes(m)).toBe(true));
  it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER])('rejects invalid duration %s',m=>expect(validMinutes(m)).toBe(false));
  it('waits before the deadline, sends within grace, and prompts for stale alarms',()=>{const s={...defaultState(),status:'BREAK_SCHEDULED' as const,scheduledAt:100_000};expect(dueDecision(s,90_000)).toBe('wait');expect(dueDecision(s,100_001)).toBe('send');expect(dueDecision(s,160_001)).toBe('overdue');});
  it('never replays an alarm once Back is pending',()=>expect(dueDecision({...defaultState(),status:'BACK_PENDING',scheduledAt:1000},2000)).toBe('none'));
  it('sets Back pending only after confirmed Break',()=>{const s=complete(defaultState(),op,receipt);expect(s.status).toBe('BACK_PENDING');expect(s.backPending).toBe(true);expect(s.breakSentAt).toBe(2000);});
  it('clears Back pending only after confirmed Back',()=>{const pending=complete(defaultState(),op,receipt);const failed=complete(pending,{...op,text:'Back'},{...receipt,outcome:'failed'});expect(failed.backPending).toBe(true);const result=complete(failed,{...op,text:'Back'},receipt);expect(result.backPending).toBe(false);expect(result.status).toBe('AVAILABLE');});
  it('preserves an uncertain operation for manual review',()=>{const s=complete(defaultState(),op,{...receipt,outcome:'uncertain'});expect(s.status).toBe('UNCERTAIN');expect(s.operation?.id).toBe(op.id);expect(s.history).toHaveLength(0);});
  it('keeps only 40 recent confirmed messages',()=>{let s=defaultState();for(let i=0;i<50;i++) s=complete(s,{...op,id:String(i)},receipt);expect(s.history).toHaveLength(40);});
  it('does not postpone a reminder every time the worker recovers',async()=>{
    const create=vi.fn(); const existing={scheduledTime:Date.now()+60_000};
    vi.stubGlobal('chrome',{alarms:{get:vi.fn().mockResolvedValue(existing),create,clear:vi.fn()}});
    await restoreAlarms({...defaultState(),backPending:true,status:'BACK_PENDING'});
    expect(create).not.toHaveBeenCalled();vi.unstubAllGlobals();
  });
});
