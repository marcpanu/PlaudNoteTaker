// Empty preload — IPC surface is added in Phase 3.
// Exists so the Vite build pipeline and Forge packaging can reference it
// without failures, and so Phase 3 can wire contextBridge without reshuffling config.
export {};
