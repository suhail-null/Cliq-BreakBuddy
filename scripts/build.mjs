import {build as viteBuild} from 'vite';
import {mkdir,copyFile,writeFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
await viteBuild({build:{outDir:'dist',rollupOptions:{input:{popup:path.resolve('popup.html'),reminder:path.resolve('reminder.html'),sidepanel:path.resolve('sidepanel.html')}}}});
await viteBuild({configFile:false,build:{outDir:'dist',emptyOutDir:false,sourcemap:true,minify:false,target:'chrome120',lib:{entry:path.resolve('src/background/index.ts'),formats:['es'],fileName:()=> 'background.js'}}});
await viteBuild({configFile:false,build:{outDir:'dist',emptyOutDir:false,sourcemap:true,minify:false,target:'chrome120',lib:{entry:path.resolve('src/content/index.ts'),name:'BreakBuddyContent',formats:['iife'],fileName:()=> 'content.js'}}});
await mkdir('dist/icons',{recursive:true});
for(const size of [16,32,48,128]) await copyFile(`public/icons/icon${size}.png`,`dist/icons/icon${size}.png`);
const manifest={manifest_version:3,name:'Cliq BreakBuddy',version:'1.3.0',minimum_chrome_version:'120',description:'Schedule Cliq Break/Back and custom messages with optional Telegram delivery reports in a persistent side panel.',
  permissions:['storage','alarms','notifications','idle','scripting','sidePanel','tabs'],host_permissions:['https://cliq.zoho.com/*','https://api.telegram.org/*'],
  background:{service_worker:'background.js',type:'module'},action:{default_title:'Open BreakBuddy side panel',default_icon:{16:'icons/icon16.png',32:'icons/icon32.png'}},
  side_panel:{default_path:'sidepanel.html'},
  commands:{'_execute_action':{suggested_key:{default:'Alt+Shift+B'},description:'Open BreakBuddy side panel'}},
  icons:{16:'icons/icon16.png',32:'icons/icon32.png',48:'icons/icon48.png',128:'icons/icon128.png'},
  content_scripts:[{matches:['https://cliq.zoho.com/company/717321507/*'],js:['content.js'],run_at:'document_idle'}],
  content_security_policy:{extension_pages:"script-src 'self'; object-src 'self'"}};
await writeFile('dist/manifest.json',JSON.stringify(manifest,null,2));
// Replace only the generated extension directory so old bundles are never shipped.
const output=path.resolve('extension');
if(path.dirname(output)!==process.cwd() || path.basename(output)!=='extension')throw new Error('Unexpected extension output directory.');
await rm(output,{recursive:true,force:true});
await cp('dist',output,{recursive:true,force:true});
console.log('Ready: select the extension folder in chrome://extensions â†’ Load unpacked.');

