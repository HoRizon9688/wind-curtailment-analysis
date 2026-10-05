// Vite/Data source builds inline the complete Worker graph, preserving subpaths.
import CalculationWorker from './calculation.worker.mjs?worker&inline';
import {createCalculationClient as createClient} from './calculation-client.mjs';
export function createCalculationClient(options) {
  return createClient({...options,workerFactory:()=>new CalculationWorker()});
}
