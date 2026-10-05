// Node-only adapter: exercises the REAL Worker entry without a browser shim in production.
import {parentPort} from 'node:worker_threads';
globalThis.self={addEventListener:(type,handler)=>{if(type==='message')parentPort.on('message',data=>handler({data}));},postMessage:message=>parentPort.postMessage(message)};
await import('../../dashboard/src/content/calculation/calculation.worker.mjs');
