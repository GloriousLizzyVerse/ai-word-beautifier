export type PickedFile = {
  filePath: string;
  name: string;
  ext: string;
  text?: string;
  bytes?: Uint8Array;
};

export type WorkspaceDoc = {
  name: string;
  size: number;
  mtime: string;
};

export type DesktopApi = {
  isDesktop: boolean;
  pickFolder: () => Promise<string | null>;
  pickFile: () => Promise<PickedFile | null>;
  saveDoc: (dir: string, fileName: string, data: Uint8Array) => Promise<{ ok: boolean; path?: string; error?: string }>;
  listDocs: (dir: string) => Promise<WorkspaceDoc[]>;
  showInFolder: (filePath: string) => Promise<boolean>;
};

declare global {
  interface Window {
    desktopAPI?: DesktopApi;
  }
}

/** True only when the page runs inside the packaged desktop client. */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.desktopAPI?.isDesktop);
}

export function getDesktopApi(): DesktopApi | null {
  if (!isDesktopApp()) return null;
  return window.desktopAPI || null;
}

export function folderName(path: string): string {
  const cleaned = (path || '').replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/** Writes a .docx blob into the desktop working directory. */
export async function saveDocToWorkspace(dir: string, fileName: string, blob: Blob): Promise<{ ok: boolean; path?: string; error?: string }> {
  const api = getDesktopApi();
  if (!api || !dir) return { ok: false, error: 'not_desktop' };
  const buffer = new Uint8Array(await blob.arrayBuffer());
  return api.saveDoc(dir, fileName, buffer);
}
