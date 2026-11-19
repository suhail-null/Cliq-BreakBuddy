import type { Operation, Receipt, State } from '../types';
export function complete(state: State, op: Operation, receipt: Receipt, manual = false): State {
  if (receipt.outcome === 'confirmed') {
    return {...state, status:op.text === 'Break' ? 'BACK_PENDING' : 'AVAILABLE', scheduledAt:null,
      backPending:op.text === 'Break', breakSentAt:op.text === 'Break' ? receipt.at : state.breakSentAt,
      lastBackAt:op.text === 'Back' ? receipt.at : state.lastBackAt, submission:'confirmed', operation:null,
      snoozeUntil:null, lastReminderAt:null, error:null,
      history:[{id:op.id,text:op.text,group:op.group,destination:op.destination,at:receipt.at,proof:manual ? 'manual' as const : 'ui' as const},...state.history].slice(0,40)};
  }
  return {...state, status:receipt.outcome === 'uncertain' ? 'UNCERTAIN' : 'ERROR', submission:receipt.outcome,
    error:receipt.detail, operation:op};
}
