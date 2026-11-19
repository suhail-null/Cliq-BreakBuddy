import type {CSSProperties} from 'react';
const paths={
  message:'M4 4h16v12H9l-5 4V4Zm4 4h8m-8 4h5',send:'m22 2-7 20-4-9L2 9 22 2Zm0 0L11 13',calendar:'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Zm2-2v4m10-4v4M3 10h18m-13 4h2m4 0h2m-8 3h2',
  minus:'M5 12h14',plus:'M5 12h14M12 5v14',
  arrow:'M5 12h14m-5-5 5 5-5 5',back:'m14 6-6 6 6 6',check:'m5 12 4 4L19 6',
  clock:'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',activity:'M3 12h4l3-8 4 16 3-8h4',
  settings:'M10.01 4.56 10.44 2.12h3.12l.43 2.44 1.86.77 2.03-1.42 2.21 2.21-1.42 2.03.77 1.86 2.44.43v3.12l-2.44.43-.77 1.86 1.42 2.03-2.21 2.21-2.03-1.42-1.86.77-.43 2.44h-3.12l-.43-2.44-1.86-.77-2.03 1.42-2.21-2.21 1.42-2.03-.77-1.86-2.44-.43v-3.12l2.44-.43.77-1.86-1.42-2.03 2.21-2.21 2.03 1.42Z M15.25 12a3.25 3.25 0 1 1-6.5 0 3.25 3.25 0 0 1 6.5 0Z',
  window:'M4 4h16v16H4zM4 9h16M14 9v11',external:'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  coffee:'M4 8h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Zm13 1h1a3 3 0 1 1 0 6h-1M7 2v2m4-2v2m4-2v2',
  shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',bell:'M6 9a6 6 0 0 1 12 0v6l2 3H4l2-3V9Zm4 12h4',
  pause:'M8 5v14M16 5v14',alert:'M12 8v5m0 4h.01M12 2 1 21h22L12 2Z',close:'m6 6 12 12M6 18 18 6',spark:'m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z',
} as const;
export type IconName=keyof typeof paths;
export function Icon({name,size=20,style}:{name:IconName;size?:number;style?:CSSProperties}) {
  return <svg className="ui-icon" data-icon={name} aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{...style,'--icon-size':`${size}px`} as CSSProperties}><path d={paths[name]}/></svg>;
}
