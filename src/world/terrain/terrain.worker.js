// Module worker: runs the island generator off the main thread and transfers the grids back.
import { generateTerrain } from './gen/generate.js';

self.onmessage = (e) => {
  try {
    const r = generateTerrain(e.data, (p, label) => self.postMessage({ type: 'progress', p, label }));
    const transfer = [r.heights.buffer, r.flow.buffer, r.seaDist.buffer, r.coastIn.buffer, r.info.buffer, r.mask.buffer];
    self.postMessage({ type: 'done', result: r }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack ?? err) });
  }
};
