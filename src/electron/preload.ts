import { contextBridge, ipcRenderer } from 'electron';

const electronKnowledgeBridge = {
  readSubject: (subjectId: string) =>
    ipcRenderer.invoke('knowledge:read-subject', subjectId) as Promise<unknown>,
  writeSubject: (subjectId: string, snapshot: unknown) =>
    ipcRenderer.invoke('knowledge:write-subject', subjectId, snapshot) as Promise<void>,
  listSubjects: () => ipcRenderer.invoke('knowledge:list-subjects') as Promise<string[]>,
  deleteSubject: (subjectId: string) =>
    ipcRenderer.invoke('knowledge:delete-subject', subjectId) as Promise<void>,
  openSubjectsFolder: () => ipcRenderer.invoke('knowledge:open-subjects-folder') as Promise<boolean>,
  exportSubjectsRoot: () => ipcRenderer.invoke('knowledge:export-subjects-root') as Promise<string | null>,
  exportSubjectFolder: (subjectId: string) =>
    ipcRenderer.invoke('knowledge:export-subject-folder', subjectId) as Promise<string | null>,
  importSubjectFolder: () =>
    ipcRenderer.invoke('knowledge:import-subject-folder') as Promise<unknown>,
  addRoomLocalAttachment: (subjectId: string, roomId: string) =>
    ipcRenderer.invoke('knowledge:add-room-local-attachment', subjectId, roomId) as Promise<unknown>,
  addRoomExternalAttachment: (subjectId: string, roomId: string, url: string) =>
    ipcRenderer.invoke('knowledge:add-room-external-attachment', subjectId, roomId, url) as Promise<unknown>,
  deleteRoomAttachment: (subjectId: string, roomId: string, attachmentId: string) =>
    ipcRenderer.invoke(
      'knowledge:delete-room-attachment',
      subjectId,
      roomId,
      attachmentId,
    ) as Promise<boolean>,
  resolveRoomAttachmentUrl: (subjectId: string, roomId: string, attachmentId: string) =>
    ipcRenderer.invoke(
      'knowledge:resolve-room-attachment-url',
      subjectId,
      roomId,
      attachmentId,
    ) as Promise<string | null>,
};

contextBridge.exposeInMainWorld('electronKnowledgeBridge', electronKnowledgeBridge);
