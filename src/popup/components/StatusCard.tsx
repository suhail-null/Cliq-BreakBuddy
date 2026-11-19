import type {State} from '../../types';
import {Icon} from './Icon';
export const statusLabels:Record<State['status'],string>={AVAILABLE:'Available',BREAK_SCHEDULED:'Break scheduled',OVERDUE:'Missed schedule',SENDING_BREAK:'Sending Break',BACK_PENDING:'Back pending',SENDING_BACK:'Sending Back',ERROR:'Needs attention',UNCERTAIN:'Check your chat'};
export function time(timestamp:number|null) {return timestamp?new Date(timestamp).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'—';}
function countdown(timestamp:number,now:number) {const seconds=Math.max(0,Math.ceil((timestamp-now)/1000));return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;}
export function StatusCard({state,now}:{state:State;now:number}) {
  const scheduled=state.status==='BREAK_SCHEDULED';const pending=state.backPending;
  const problem=['ERROR','UNCERTAIN','OVERDUE'].includes(state.status);const sending=state.status.startsWith('SENDING_');
  const title=scheduled?'A pause is on the way.':pending?'Back at your desk?':sending?'Taking care of it.':problem?'Let’s check this together.':'Good work needs a little pause.';
  const note=scheduled?`We’ll post Break at ${time(state.scheduledAt)}.`:pending?`Your Break was confirmed at ${time(state.breakSentAt)}.`:sending?'Waiting for your message to appear in Cliq.':problem?'Your status stays safe while you review.':'We’ll handle the Break. You enjoy the breather.';
  return <article className={`status-card ${pending?'is-pending':''} ${scheduled?'is-scheduled':''} ${problem?'is-problem':''}`}>
    <div className="card-top"><span className="status-tag"><span className="status-dot"/>{statusLabels[state.status]}</span><Icon name={pending?'sun':scheduled?'clock':problem?'alert':'spark'} size={18}/></div>
    <div className={`orb ${scheduled?'is-timer':''}`} aria-hidden="true">
      <svg className="orbit-lines" viewBox="0 0 200 200" fill="none"><circle cx="100" cy="100" r="90" stroke="currentColor" strokeDasharray="1 9" strokeWidth="2"/><circle cx="100" cy="100" r="72" stroke="currentColor" strokeWidth=".6"/><path d="M32 64a78 78 0 0 1 138 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>
      {scheduled?<div className="timer-face"><span>{countdown(state.scheduledAt!,now)}</span><small>UNTIL YOUR BREAK</small></div>:<div className="cup-art"><svg className="steam" viewBox="0 0 42 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M9 21c-5-6 5-9 0-16"/><path d="M21 19c-5-6 5-9 0-16"/><path d="M33 21c-5-6 5-9 0-16"/></svg><svg className="cup-illustration" viewBox="0 0 120 100" fill="none"><path d="M20 29h65v36a24 24 0 0 1-24 24H44a24 24 0 0 1-24-24V29Z" fill="currentColor"/><path d="M85 38h9a16 16 0 1 1 0 32H85" stroke="currentColor" strokeWidth="8"/><path d="M17 96h73" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><path d="m42 53 9 9 17-18" stroke="var(--cup-mark)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg><span className="orbit-spark"><Icon name="spark" size={14}/></span></div>}
    </div>
    {scheduled && <p className="visually-hidden">Time until Break: {countdown(state.scheduledAt!,now)}</p>}
    <div className="hero-copy"><h2 tabIndex={-1}>{title}</h2><p>{note}</p></div>
    {sending && <div className="send-progress" role="progressbar" aria-label="Waiting for Cliq confirmation"><span/></div>}
  </article>;
}
