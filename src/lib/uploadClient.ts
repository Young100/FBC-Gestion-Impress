import { getStaffAuthHeaders } from './adminApi';
import { getClientSessionToken } from './clientApi';
import type { UploadedFileMeta } from '../types/fbc';

export interface UploadProgressState {
  id: string;
  fileName: string;
  totalBytes: number;
  uploadedBytes: number;
  percent: number;
  speedBytesPerSec: number;
  status: 'queued' | 'hashing' | 'uploading' | 'paused' | 'completed' | 'error';
  errorMessage?: string;
}

export interface ResumableUploadController {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

async function computeSha256Hex(file: File): Promise<string | undefined> {
  try {
    // Skip browser-side full buffer hashing on massive >300MB files to protect entry-level phone RAM
    if (file.size > 300 * 1024 * 1024 || !window.crypto?.subtle) {
      return undefined;
    }
    const buffer = await file.arrayBuffer();
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

export function startResumableUpload(
  file: File,
  params: {
    itemId: string;
    slotKey: string;
    slotLabel: string;
    version?: number;
    purpose?: 'order_file' | 'payment_proof' | 'service_image';
    authMode?: 'client' | 'staff';
  },
  onProgress: (state: UploadProgressState) => void
): { promise: Promise<UploadedFileMeta>; controller: ResumableUploadController } {
  const useStaffAuth = params.authMode === 'staff' || params.purpose === 'service_image';

  const buildAuthHeaders = async (extra?: Record<string, string>): Promise<Headers> => {
    if (useStaffAuth) {
      return getStaffAuthHeaders(extra);
    }
    const headers = new Headers(extra || {});
    const clientToken = getClientSessionToken();
    if (clientToken) {
      headers.set('X-Client-Session', clientToken);
    }
    return headers;
  };
  const localId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let isPaused = false;
  let isCancelled = false;
  let resumeResolver: (() => void) | null = null;
  let activeAbort: AbortController | null = null;

  const controller: ResumableUploadController = {
    pause: () => {
      isPaused = true;
      activeAbort?.abort();
      onProgress({
        id: localId,
        fileName: file.name,
        totalBytes: file.size,
        uploadedBytes: lastUploaded,
        percent: Math.round((lastUploaded / Math.max(1, file.size)) * 100),
        speedBytesPerSec: 0,
        status: 'paused',
      });
    },
    resume: () => {
      isPaused = false;
      if (resumeResolver) {
        resumeResolver();
        resumeResolver = null;
      }
    },
    cancel: () => {
      isCancelled = true;
      isPaused = false;
      activeAbort?.abort();
      if (resumeResolver) {
        resumeResolver();
        resumeResolver = null;
      }
    },
  };

  let lastUploaded = 0;

  const promise = (async (): Promise<UploadedFileMeta> => {
    if (file.size <= 0) {
      throw new Error('Le fichier est vide (0 octet).');
    }

    onProgress({
      id: localId,
      fileName: file.name,
      totalBytes: file.size,
      uploadedBytes: 0,
      percent: 0,
      speedBytesPerSec: 0,
      status: 'hashing',
    });

    const clientSha256 = await computeSha256Hex(file);

    // 1. Initialize server upload session
    const initHeaders = await buildAuthHeaders({ 'Content-Type': 'application/json' });
    const initRes = await fetch('/api/uploads/init', {
      method: 'POST',
      headers: initHeaders,
      credentials: 'include',
      body: JSON.stringify({
        fileName: file.name,
        totalSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        purpose: params.purpose || 'order_file',
      }),
    });

    if (!initRes.ok) {
      const errData = await initRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Impossible d’initialiser le transfert.');
    }

    const { fileId, chunkSize } = (await initRes.json()) as {
      fileId: string;
      chunkSize: number;
    };

    let offset = 0;
    let retries = 0;

    while (offset < file.size) {
      if (isCancelled) {
        throw new Error('Transfert annulé.');
      }

      if (isPaused) {
        await new Promise<void>((resolve) => {
          resumeResolver = resolve;
        });
        continue;
      }

      const end = Math.min(offset + chunkSize, file.size);
      const chunkBlob = file.slice(offset, end);
      const tStart = performance.now();
      activeAbort = new AbortController();

      try {
        const chunkHeaders = await buildAuthHeaders({
          'Content-Type': 'application/octet-stream',
          'x-chunk-offset': String(offset),
        });
        const putRes = await fetch(`/api/uploads/${fileId}/chunk`, {
          method: 'PUT',
          headers: chunkHeaders,
          credentials: 'include',
          body: chunkBlob,
          signal: activeAbort.signal,
        });

        if (!putRes.ok) {
          throw new Error(`Erreur serveur (${putRes.status})`);
        }

        retries = 0;
        offset = end;
        lastUploaded = offset;

        const elapsedSec = Math.max(0.05, (performance.now() - tStart) / 1000);
        const speedBytesPerSec = chunkBlob.size / elapsedSec;

        onProgress({
          id: localId,
          fileName: file.name,
          totalBytes: file.size,
          uploadedBytes: offset,
          percent: Math.round((offset / file.size) * 100),
          speedBytesPerSec,
          status: 'uploading',
        });
      } catch (err) {
        if (isCancelled) throw new Error('Transfert annulé.');
        if (isPaused) continue;

        retries += 1;
        if (retries > 6) {
          onProgress({
            id: localId,
            fileName: file.name,
            totalBytes: file.size,
            uploadedBytes: offset,
            percent: Math.round((offset / file.size) * 100),
            speedBytesPerSec: 0,
            status: 'error',
            errorMessage:
              err instanceof Error
                ? `Coupure réseau persistante : ${err.message}`
                : 'Coupure réseau persistante.',
          });
          throw err;
        }

        // Check server offset in case chunk succeeded before disconnect, then wait before retry
        await new Promise((r) => setTimeout(r, Math.min(4000, 600 * retries)));
        try {
          const statusHeaders = await buildAuthHeaders();
          const statusRes = await fetch(`/api/uploads/${fileId}/status`, {
            headers: statusHeaders,
            credentials: 'include',
          });
          if (statusRes.ok) {
            const st = await statusRes.json();
            if (typeof st.uploadedBytes === 'number' && st.uploadedBytes > offset) {
              offset = st.uploadedBytes;
              lastUploaded = offset;
            }
          }
        } catch {
          // ignore status probe error and retry chunk
        }
      }
    }

    // 2. Complete & verify SHA-256 integrity
    const completeHeaders = await buildAuthHeaders({ 'Content-Type': 'application/json' });
    const completeRes = await fetch(`/api/uploads/${fileId}/complete`, {
      method: 'POST',
      headers: completeHeaders,
      credentials: 'include',
      body: JSON.stringify({ clientSha256 }),
    });

    if (!completeRes.ok) {
      const errData = await completeRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Échec de finalisation du fichier.');
    }

    const result = await completeRes.json();
    onProgress({
      id: localId,
      fileName: file.name,
      totalBytes: file.size,
      uploadedBytes: file.size,
      percent: 100,
      speedBytesPerSec: 0,
      status: 'completed',
    });

    const meta: UploadedFileMeta = {
      fileId: result.fileId,
      itemId: params.itemId,
      slotKey: params.slotKey,
      slotLabel: params.slotLabel,
      originalName: result.originalName,
      extension: result.extension,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      ...(typeof result.widthPx === 'number' ? { widthPx: result.widthPx } : {}),
      ...(typeof result.heightPx === 'number' ? { heightPx: result.heightPx } : {}),
      ...(typeof result.widthCm === 'number' ? { widthCm: result.widthCm } : {}),
      ...(typeof result.heightCm === 'number' ? { heightCm: result.heightCm } : {}),
      ...(typeof result.pageCount === 'number' ? { pageCount: result.pageCount } : {}),
      ...(typeof result.colorSpace === 'string' ? { colorSpace: result.colorSpace } : {}),
      previewAvailable: Boolean(result.previewAvailable),
      version: params.version || 1,
      uploadedAt: new Date().toISOString(),
    };

    return meta;
  })();

  return { promise, controller };
}
