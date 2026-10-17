import {build} from '../../dashboard/node_modules/vite/dist/node/index.js';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync} from 'node:fs';
const root=resolve('dashboard'),out=resolve('reports/browser-review/optimization-2026-10-17/ssr');mkdirSync(out,{recursive:true});
await build({root,configFile:false,logLevel:'warn',resolve:{alias:{react:join(root,'node_modules/react'),'react-dom':join(root,'node_modules/react-dom')}},ssr:{noExternal:true},build:{ssr:resolve('tests/browser/optimization-ssr-entry.jsx'),outDir:out,emptyOutDir:true,rollupOptions:{output:{entryFileNames:'check.mjs'}}}});
await import(pathToFileURL(join(out,'check.mjs')));
