import { defaultState } from '../config';
import type { Profile, State } from '../types';
export async function readState(): Promise<State> {
  const {state} = await chrome.storage.local.get('state');
  const defaults=defaultState();
  const profile:Profile={...defaults.profile,...state?.profile};
  // Migrate empty fields from the earlier manual-setup builds without replacing user overrides.
  for(const key of Object.keys(defaults.profile) as (keyof Profile)[]) if(!profile[key]?.trim()) profile[key]=defaults.profile[key];
  const result:State={...defaults, ...state, profile};
  // Retired test destinations must never silently start sending to MarTech.
  if(result.group==='test') {
    const previousDestination=result.operation?.destination??result.history.find(item=>item.text==='Break'&&item.destination)?.destination;
    if(previousDestination && (result.backPending || result.status==='UNCERTAIN')) {
      result.group='custom';result.customDestination=previousDestination;result.productionEnabled=true;
      if(result.operation)result.operation={...result.operation,group:'custom'};
    } else if(result.status==='AVAILABLE' || result.status==='BREAK_SCHEDULED' || result.status==='OVERDUE') {
      result.group='production';result.productionEnabled=false;result.status='AVAILABLE';result.scheduledAt=null;result.operation=null;
    }
  }
  return result;
}
export async function writeState(state: State) { await chrome.storage.local.set({state}); }
