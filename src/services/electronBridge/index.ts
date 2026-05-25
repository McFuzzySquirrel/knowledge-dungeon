/**
 * Type-safe wrapper around the Electron preload bridge.
 * Returns null in the web build where no bridge is available.
 */
export function isElectronAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.electronKnowledgeBridge !== 'undefined'
  );
}

export function getElectronEnvironmentLabel(): 'desktop' | 'web' {
  return isElectronAvailable() ? 'desktop' : 'web';
}
