// Worker entry point: bundled by scripts/build.mjs into a string that the
// plugin starts from a Blob URL. WASM bytes arrive in the INIT message.
import initWasm, { GraphPhysicsWasm } from './generated/graph-physics-glue.js';
import { createWorkerCore } from './worker-core';
import type { ToWorker } from './protocol';

declare const self: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const core = createWorkerCore(
  {
    post: (message, transfer) => self.postMessage(message, transfer ?? []),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  {
    init: async module => (await initWasm({ module_or_path: module })) as unknown as { memory: WebAssembly.Memory },
    create: (count, edges, params) => new GraphPhysicsWasm(count, edges, params),
  },
);

let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<ToWorker>) => {
  // Messages are handled in order; INIT awaits WASM compilation.
  queue = queue.then(() => core.handle(event.data));
};
