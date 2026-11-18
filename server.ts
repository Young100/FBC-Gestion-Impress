import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import imageSize from 'image-size';
import { PDFDocument } from 'pdf-lib';
import { createServer as createViteServer } from 'vite';

const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver') as {
  ZipArchive: new (options?: import('archiver').ArchiverOptions) => import('archiver').Archiver;
};

const PORT = 3000;
const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const FILES_DIR = path.join(UPLOADS_ROOT, 'files');
const INDEX_FILE = path.join(UPLOADS_ROOT, 'index.json');

fs.mkdirSync(FILES_DIR, { recursive: true });

interface StoredFileRecord {
  fileId: string;
  originalName: string;
  safeStorageName: string;
  extension: string;
  mimeType: string;
  totalSize: number;
  uploadedBytes: number;
  complete: boolean;
  sha256: string;
  widthPx?: number;
  heightPx?: number;
  widthCm?: number;
  heightCm?: number;
  pageCount?: number;
  colorSpace?: string;
  previewAvailable: boolean;
  createdAt: string;
}

function loadIndex(): Record<string, StoredFileRecord> {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to read uploads index:', err);
  }
  return {};
}

function saveIndex(index: Record<string, StoredFileRecord>) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

const uploadsIndex: Record<string, StoredFileRecord> = loadIndex();

function detectJpegColorSpace(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(65536, fs.statSync(filePath).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    let offset = 2;
    while (offset + 4 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segLen = buf.readUInt16BE(offset + 2);
      // SOF0, SOF1, SOF2 markers specify number of color components
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 9 < buf.length) {
        const components = buf[offset + 9];
        if (components === 4) return 'CMJN';
        if (components === 3) return 'RVB';
        if (components === 1) return 'Niveaux de gris';
      }
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function analyzeFileMetadata(record: StoredFileRecord, filePath: string) {
  const ext = record.extension.toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.tif', '.svg'];
  if (imageExts.includes(ext)) {
    try {
      const buffer = fs.readFileSync(filePath);
      const dims = imageSize(buffer);
      if (dims.width && dims.height) {
        record.widthPx = dims.width;
        record.heightPx = dims.height;
      }
      record.previewAvailable = ext !== '.tiff' && ext !== '.tif';
      if (ext === '.jpg' || ext === '.jpeg') {
        record.colorSpace = detectJpegColorSpace(filePath) || 'RVB';
      } else if (ext === '.png' || ext === '.svg' || ext === '.webp') {
        record.colorSpace = 'RVB';
      }
    } catch (err) {
      console.warn('Image metadata inspection warning:', err);
      record.previewAvailable = false;
    }
  } else if (ext === '.pdf') {
    try {
      const pdfBytes = fs.readFileSync(filePath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pages = pdfDoc.getPages();
      record.pageCount = pages.length;
      if (pages.length > 0) {
        const { width, height } = pages[0].getSize();
        // PDF points: 72 pt = 1 inch = 2.54 cm
        record.widthCm = Math.round((width / 72) * 2.54 * 10) / 10;
        record.heightCm = Math.round((height / 72) * 2.54 * 10) / 10;
      }
      record.previewAvailable = true;
      record.colorSpace = 'PDF (Vectoriel/Mixte)';
    } catch (err) {
      console.warn('PDF metadata inspection warning:', err);
      record.previewAvailable = true;
    }
  } else {
    record.previewAvailable = false;
    record.colorSpace = 'Source native';
  }
}

function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'fbc-print-server', timestamp: new Date().toISOString() });
  });

  // 1. Initialize a chunked resumable upload (no compression)
  app.post('/api/uploads/init', (req, res) => {
    const { fileName, totalSize, mimeType } = req.body as {
      fileName?: string;
      totalSize?: number;
      mimeType?: string;
    };

    if (!fileName || typeof totalSize !== 'number' || totalSize <= 0) {
      res.status(400).json({ error: 'Fichier vide ou paramètres invalides.' });
      return;
    }

    const ext = path.extname(fileName).toLowerCase();
    const fileId = `fil_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const safeStorageName = `${fileId}${ext || '.bin'}`;
    const targetPath = path.join(FILES_DIR, safeStorageName);

    fs.writeFileSync(targetPath, Buffer.alloc(0));

    const record: StoredFileRecord = {
      fileId,
      originalName: path.basename(fileName),
      safeStorageName,
      extension: ext,
      mimeType: mimeType || 'application/octet-stream',
      totalSize,
      uploadedBytes: 0,
      complete: false,
      sha256: '',
      previewAvailable: false,
      createdAt: new Date().toISOString(),
    };

    uploadsIndex[fileId] = record;
    saveIndex(uploadsIndex);

    res.json({
      fileId,
      chunkSize: 1024 * 1024, // 1 MB chunks for stable mobile resume
      uploadedBytes: 0,
    });
  });

  // 2. Check upload status for automatic resume after network drop
  app.get('/api/uploads/:fileId/status', (req, res) => {
    const record = uploadsIndex[req.params.fileId];
    if (!record) {
      res.status(404).json({ error: 'Session de transfert introuvable.' });
      return;
    }
    const targetPath = path.join(FILES_DIR, record.safeStorageName);
    const actualSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
    record.uploadedBytes = actualSize;
    res.json({
      fileId: record.fileId,
      uploadedBytes: actualSize,
      totalSize: record.totalSize,
      complete: record.complete,
    });
  });

  // 3. Receive raw binary chunk at exact byte offset (resumable, uncompressed)
  app.put(
    '/api/uploads/:fileId/chunk',
    express.raw({ type: 'application/octet-stream', limit: '16mb' }),
    (req, res) => {
      const record = uploadsIndex[req.params.fileId];
      if (!record) {
        res.status(404).json({ error: 'Session de transfert introuvable.' });
        return;
      }

      const offsetHeader = req.headers['x-chunk-offset'];
      const offset = typeof offsetHeader === 'string' ? parseInt(offsetHeader, 10) : NaN;
      const chunkBuffer = req.body as Buffer;

      if (Number.isNaN(offset) || offset < 0 || !Buffer.isBuffer(chunkBuffer)) {
        res.status(400).json({ error: 'Décalage ou bloc binaire invalide.' });
        return;
      }

      const targetPath = path.join(FILES_DIR, record.safeStorageName);
      const fd = fs.openSync(targetPath, 'r+');
      try {
        fs.writeSync(fd, chunkBuffer, 0, chunkBuffer.length, offset);
      } finally {
        fs.closeSync(fd);
      }

      const currentSize = fs.statSync(targetPath).size;
      record.uploadedBytes = currentSize;
      saveIndex(uploadsIndex);

      res.json({
        fileId: record.fileId,
        uploadedBytes: currentSize,
        totalSize: record.totalSize,
      });
    }
  );

  // 4. Finalize upload: verify byte size, compute SHA-256, inspect dimensions/DPI/colorSpace
  app.post('/api/uploads/:fileId/complete', async (req, res) => {
    const record = uploadsIndex[req.params.fileId];
    if (!record) {
      res.status(404).json({ error: 'Session de transfert introuvable.' });
      return;
    }

    const targetPath = path.join(FILES_DIR, record.safeStorageName);
    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Fichier manquant sur le stockage.' });
      return;
    }

    const actualSize = fs.statSync(targetPath).size;
    if (actualSize !== record.totalSize) {
      res.status(400).json({
        error: `Taille incomplète (${actualSize} / ${record.totalSize} octets).`,
        uploadedBytes: actualSize,
      });
      return;
    }

    const serverSha256 = await computeFileSha256(targetPath);
    const { clientSha256 } = (req.body || {}) as { clientSha256?: string };
    if (clientSha256 && clientSha256.toLowerCase() !== serverSha256.toLowerCase()) {
      res.status(422).json({
        error: 'Échec de vérification d’intégrité SHA-256. Veuillez renvoyer le fichier.',
      });
      return;
    }

    record.sha256 = serverSha256;
    record.uploadedBytes = actualSize;
    record.complete = true;

    await analyzeFileMetadata(record, targetPath);
    saveIndex(uploadsIndex);

    res.json({
      fileId: record.fileId,
      originalName: record.originalName,
      extension: record.extension,
      mimeType: record.mimeType,
      sizeBytes: record.totalSize,
      sha256: record.sha256,
      widthPx: record.widthPx,
      heightPx: record.heightPx,
      widthCm: record.widthCm,
      heightCm: record.heightCm,
      pageCount: record.pageCount,
      colorSpace: record.colorSpace,
      previewAvailable: record.previewAvailable,
    });
  });

  // 5. Download original uncompressed file byte-for-byte
  app.get('/api/files/:fileId/download', (req, res) => {
    const record = uploadsIndex[req.params.fileId];
    if (!record || !record.complete) {
      res.status(404).json({ error: 'Fichier introuvable.' });
      return;
    }
    const targetPath = path.join(FILES_DIR, record.safeStorageName);
    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Fichier physique absent.' });
      return;
    }

    res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(record.totalSize));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(record.originalName)}`
    );
    fs.createReadStream(targetPath).pipe(res);
  });

  // 6. Preview file inline (images & PDFs) without altering the original file
  app.get('/api/files/:fileId/preview', (req, res) => {
    const record = uploadsIndex[req.params.fileId];
    if (!record || !record.complete) {
      res.status(404).json({ error: 'Aperçu indisponible.' });
      return;
    }
    const targetPath = path.join(FILES_DIR, record.safeStorageName);
    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Fichier physique absent.' });
      return;
    }

    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
    };
    res.setHeader('Content-Type', mimeMap[record.extension] || record.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(record.originalName)}`);
    fs.createReadStream(targetPath).pipe(res);
  });

  // 7. Bundle all original files of an order into a single ZIP without recompression
  app.post('/api/orders/:orderId/files-zip', (req, res) => {
    const { files, orderNumber } = (req.body || {}) as {
      files?: Array<{ fileId: string; originalName?: string; slotLabel?: string }>;
      orderNumber?: string;
    };

    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'Aucun fichier à archiver.' });
      return;
    }

    const entries: Array<{ targetPath: string; entryName: string }> = [];
    const usedNames = new Set<string>();
    for (const item of files) {
      const record = uploadsIndex[item.fileId];
      if (!record || !record.complete) continue;
      const targetPath = path.join(FILES_DIR, record.safeStorageName);
      if (!fs.existsSync(targetPath)) continue;

      const prefix = item.slotLabel ? `[${item.slotLabel.replace(/[^a-zA-Z0-9_-]/g, '_')}]_` : '';
      let entryName = `${prefix}${record.originalName}`;
      let counter = 1;
      while (usedNames.has(entryName)) {
        entryName = `${counter}_${prefix}${record.originalName}`;
        counter++;
      }
      usedNames.add(entryName);
      entries.push({ targetPath, entryName });
    }

    if (entries.length === 0) {
      res.status(404).json({ error: 'Aucun fichier original disponible sur le serveur pour cette commande.' });
      return;
    }

    const archiveName = `${orderNumber || req.params.orderId}_fichiers_originaux.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`
    );

    const archive = new ZipArchive({ store: true }); // store: true -> ZERO compression, byte-for-byte
    archive.on('error', (err: Error) => {
      console.error('ZIP error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Erreur lors de la création de l’archive ZIP.' });
    });
    archive.pipe(res);

    for (const entry of entries) {
      archive.file(entry.targetPath, { name: entry.entryName });
    }

    archive.finalize();
  });

  // Block direct access to internal server-views and legacy admin paths
  app.use('/server-views', (_req, res) => {
    res.status(404).send('Not Found');
  });
  app.get('/admin.html', (_req, res) => {
    res.status(404).send('Not Found');
  });

  // Mount Vite middleware in dev, or serve static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    app.get(/^\/fbcprintgestionadmin(\/.*)?$/i, async (req, res, next) => {
      try {
        const adminHtmlPath = path.resolve(process.cwd(), 'server-views/atelier.html');
        const template = fs.readFileSync(adminHtmlPath, 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.end(html);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });

    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');

    app.get(/^\/fbcprintgestionadmin(\/.*)?$/i, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(distDir, 'server-views/atelier.html'));
    });

    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FBC Print server listening on http://localhost:${PORT}`);
  });
}

startServer();
