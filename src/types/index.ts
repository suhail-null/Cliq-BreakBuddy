export type Group = 'test' | 'production' | 'custom';
export interface Destination {name: string; id: string; url: string;}
export type Status = 'AVAILABLE' | 'BREAK_SCHEDULED' | 'OVERDUE' | 'SENDING_BREAK' | 'BACK_PENDING' | 'SENDING_BACK' | 'ERROR' | 'UNCERTAIN';
export type TextMessage = string;
export interface Profile {
  root: string; chatIdAttribute: string; header: string; editor: string; send: string;
  row: string; rowIdAttribute: string; body: string; own: string; acknowledged: string;
}
export interface Operation { id: string; text: TextMessage; group: Group; startedAt: number; destination?: Destination; kind?: 'custom'; }
export interface CustomDraft {text:string; url:string; name:string; minutes:number; sendAt?:string; timing?:'delay'|'date';}
export interface CustomJob {id:string; text:string; destination:Destination; profile:Profile; scheduledAt:number; status:'scheduled'|'overdue'|'sending'|'sent'|'failed'|'uncertain'|'cancelled'; operation:Operation|null; detail:string; at?:number;}
export interface CustomData {jobs:CustomJob[]; draft:CustomDraft; destinations:Destination[];}
export interface Receipt { id: string; outcome: 'confirmed' | 'failed' | 'uncertain'; detail: string; messageId?: string; at: number; }
export interface History { id: string; text: TextMessage; group: Group; at: number; proof: 'ui' | 'manual'; destination?: Destination; }
export interface TelegramSettings {
  enabled: boolean; chatId: string; hasToken: boolean;
  controllerId: string; actionsAvailable: boolean; actionsError: string | null;
  lastAction: {ok:boolean;detail:string;at:number} | null;
  lastReport: {ok: boolean; detail: string; at: number} | null;
  pending: number;
}
export interface State {
  version: 1; group: Group; productionEnabled: boolean; profile: Profile; customDestination: Destination | null;
  status: Status; scheduledAt: number | null; breakSentAt: number | null;
  backPending: boolean; lastBackAt: number | null; snoozeUntil: number | null;
  lastReminderAt: number | null; operation: Operation | null;
  submission: 'none' | 'sending' | 'confirmed' | 'failed' | 'uncertain';
  error: string | null; history: History[];
}
export type Command =
  | {type:'GET_TELEGRAM'} | {type:'SAVE_TELEGRAM'; enabled:boolean; botToken:string; chatId:string; controllerId?:string}
  | {type:'TEST_TELEGRAM'} | {type:'DISCONNECT_TELEGRAM'}
  | {type:'FIND_TELEGRAM_CHATS'; botToken:string}
  | {type:'GET_CUSTOM'} | {type:'SAVE_CUSTOM_DRAFT'; draft:CustomDraft}
  | {type:'SCHEDULE_CUSTOM'; text:string; url:string; name:string; scheduledAt:number}
  | {type:'CUSTOM_ACTION'; id:string; action:'cancel'|'send'|'retry'|'resolve'; delivered?:boolean; checked?:boolean}
  | {type:'SAVE_DESTINATION'; url:string; name:string} | {type:'REMOVE_DESTINATION'; url:string}
  | {type: 'PANEL_VISIBILITY'; windowId: number; visible: boolean}
  | {type: 'GET'} | {type: 'SCHEDULE'; minutes: number} | {type: 'CANCEL'}
  | {type: 'BACK'} | {type: 'SNOOZE'} | {type: 'SEND_NOW'} | {type: 'RETRY'}
  | {type: 'OPEN_CLIQ'} | {type: 'INSPECT'} | {type: 'CHECK_SETUP'}
  | {type: 'SAVE_CONFIG'; group: Group; phrase: string; profile: Profile; customUrl?: string; customName?: string}
  | {type: 'RESOLVE'; delivered: boolean; checked: boolean};
