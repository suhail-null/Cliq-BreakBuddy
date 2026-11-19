import type {State} from '../../types';
import {destinationFor} from '../../config';
import {Icon} from './Icon';
import {time} from './StatusCard';
export function Activity({state}:{state:State}) {
  return <section className="activity-view"><div className="section-heading"><div><span className="eyebrow">THE LITTLE CHECK-INS</span><h2 tabIndex={-1}>Your activity</h2></div><span className="count-tag">{state.history.length}</span></div>
    <p className="muted">A record of your confirmed Break and Back messages.</p>
    {state.history.length===0?<div className="empty-state"><span className="empty-icon"><Icon name="activity" size={32}/></span><h3>A fresh start.</h3><p>Your first confirmed message will appear here.</p></div>:<ol className="activity-list">{state.history.map(item=><li key={item.id}><span className={`activity-icon ${item.text==='Back'?'returned':''}`}><Icon name={item.text==='Back'?'check':'coffee'}/></span><div><strong>{item.text==='Back'?'Back to it':'A little break'}</strong><span>{destinationFor(item.group,item.destination ?? state.customDestination).name}</span><small>{item.proof==='manual'?'Manually confirmed':'Verified in Cliq'}</small></div><time dateTime={new Date(item.at).toISOString()}>{time(item.at)}<span>{new Date(item.at).toLocaleDateString([],{month:'short',day:'numeric'})}</span></time></li>)}</ol>}
  </section>;
}
