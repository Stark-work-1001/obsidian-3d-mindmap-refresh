// Build-time modules and constants provided by scripts/build.mjs.
declare module 'virtual:physics-worker' {
  /** Source of the physics worker (IIFE), started from a Blob URL. */
  const source: string;
  export default source;
}

declare module 'virtual:katex-css' {
  /** KaTeX stylesheet with its woff2 fonts inlined as data URLs. */
  const css: string;
  export default css;
}

declare const __PLUGIN_VERSION__: string;
