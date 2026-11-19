// Offline verification fallback. Normal development uses `npm run check` (tsc).
// Usage: node scripts/check-with-monaco.mjs <path-to-monaco-typescript-lib-directory>
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const base=process.argv[2];
if(!base) throw new Error('Pass a Monaco TypeScript lib directory, or use npm run check.');
const {typescript:ts}=await import(pathToFileURL(path.resolve(base,'typescriptServices.js')));
const {libFileMap}=await import(pathToFileURL(path.resolve(base,'lib.js')));
const read=file=>libFileMap[path.basename(file)] ?? (fs.existsSync(file)?fs.readFileSync(file,'utf8'):undefined);
const list=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?list(path.join(dir,e.name)):[path.join(dir,e.name)]);
const config=ts.convertCompilerOptionsFromJson(JSON.parse(fs.readFileSync('tsconfig.json','utf8')).compilerOptions,process.cwd());
const host={getSourceFile:(file,version)=>{const text=read(file);return text===undefined?undefined:ts.createSourceFile(file,text,version,true);},
  getDefaultLibFileName:()=>path.resolve('.type-libs/lib.d.ts'),writeFile:()=>{},getCurrentDirectory:()=>process.cwd(),getDirectories:dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name):[],
  fileExists:file=>!!libFileMap[path.basename(file)] || fs.existsSync(file),readFile:read,useCaseSensitiveFileNames:()=>false,getCanonicalFileName:file=>file.toLowerCase(),getNewLine:()=> '\n'};
const program=ts.createProgram(list('src').filter(p=>/\.tsx?$/.test(p)),config.options,host);
const diagnostics=ts.getPreEmitDiagnostics(program);
for(const d of diagnostics){const position=d.file?.getLineAndCharacterOfPosition(d.start??0);console.log(`${d.file?.fileName??''}${position?`:${position.line+1}:${position.character+1}`:''} ${ts.flattenDiagnosticMessageText(d.messageText,'\n')}`);}
console.log(`TypeScript ${ts.version}: ${diagnostics.length} diagnostics.`);
process.exitCode=diagnostics.length?1:0;
