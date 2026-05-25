import { contextBridge, ipcRenderer } from 'electron';

const electronKnowledgeBridge = {
  readSubject: (subjectId: string) =>
    ipcRenderer.invoke('knowledge:read-subject', subjectId) as Promise<unknown>,
  writeSubject: (subjectId: string, snapshot: unknown) =>
    ipcRenderer.invoke('knowledge:write-subject', subjectId, snapshot) as Promise<void>,
  listSubjects: () => ipcRenderer.invoke('knowledge:list-subjects') as Promise<string[]>,
  deleteSubject: (subjectId: string) =>
    ipcRenderer.invoke('knowledge:delete-subject', subjectId) as Promise<void>,
};

contextBridge.exposeInMainWorld('electronKnowledgeBridge', electronKnowledgeBridge);
