import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import imageSize from 'image-size';
import { PDFDocument } from 'pdf-lib';
import { createServer as createViteServer } from 'vite';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, initializeFirestore, Timestamp } from 'firebase-admin/firestore';

const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver') as {
  ZipArchive: new (options?: import('archiver').ArchiverOptions) => import('archiver').Archiver;
};

const PORT = Number(process.env.PORT) || 3000;
const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const FILES_DIR = path.join(UPLOADS_ROOT, 'files');
const INDEX_FILE = path.join(UPLOADS_ROOT, 'index.json');
const SESSION_SECRET_FILE = path.join(UPLOADS_ROOT, '.staff_session_secret');
const STAFF_COOKIE_NAME = 'fbc_staff_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BOOTSTRAPPED_ADMIN_EMAIL = 'ouattaraabdoulaye479@gmail.com';
const ALLOWED_ORIGINS = new Set([
  'https://fbc-print.onrender.com',
]);

fs.mkdirSync(FILES_DIR, { recursive: true });

const firebaseConfig = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'firebase-applet-config.json'), 'utf-8')
) as { projectId: string; firestoreDatabaseId?: string };

function initFirebaseAdminApp() {
  if (getApps().length > 0) return getApps()[0];
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawServiceAccount) {
    try {
      const parsed = JSON.parse(rawServiceAccount);
      return initializeApp({
        credential: cert(parsed),
        projectId: firebaseConfig.projectId,
      });
    } catch (err) {
      console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON, falling back to ADC:', err);
    }
  }
  return initializeApp({ projectId: firebaseConfig.projectId });
}

const adminApp = initFirebaseAdminApp();
const adminAuth = getAuth(adminApp);
const adminDb =
  firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
    ? initializeFirestore(adminApp, { preferRest: true }, firebaseConfig.firestoreDatabaseId)
    : initializeFirestore(adminApp, { preferRest: true });

function getSessionSecret(): string {
  const envSecret = process.env.STAFF_SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 32) {
    return envSecret;
  }
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const existing = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SESSION_SECRET_FILE, generated, { encoding: 'utf-8', mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SESSION_SECRET = getSessionSecret();

interface StaffSessionPayload {
  accessId: string;
  role: 'admin' | 'operator';
  displayName: string;
  exp: number;
}

interface ResolvedStaffCaller {
  uid: string;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
  displayName: string;
  accessId?: string;
  authMethod: 'google' | 'credentials';
}

interface StaffCredentialDoc {
  accessId: string;
  displayName: string;
  role: 'admin' | 'operator';
  passwordHash: string;
  passwordSalt: string;
  active: boolean;
  createdBy: string;
  lastLoginAt?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function signStaffToken(payload: StaffSessionPayload): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifyStaffToken(token: string | undefined): StaffSessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf-8');
  const expBuf = Buffer.from(expectedSig, 'utf-8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf-8')
    ) as StaffSessionPayload;
    if (!parsed.accessId || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setStaffSessionCookie(
  req: express.Request,
  res: express.Response,
  token: string
) {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() === 'https';
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const attrs = isHttps
    ? `HttpOnly; Path=/; SameSite=None; Secure; Partitioned; Max-Age=${maxAgeSec}`
    : `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
  res.setHeader('Set-Cookie', `${STAFF_COOKIE_NAME}=${encodeURIComponent(token)}; ${attrs}`);
}

function clearStaffSessionCookie(req: express.Request, res: express.Response) {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() === 'https';
  const attrs = isHttps
    ? 'HttpOnly; Path=/; SameSite=None; Secure; Partitioned; Max-Age=0'
    : 'HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
  res.setHeader('Set-Cookie', `${STAFF_COOKIE_NAME}=; ${attrs}`);
}

function hashStaffPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyStaffPassword(
  password: string,
  salt: string,
  expectedHashHex: string
): boolean {
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHashHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function randomAlphaNum(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function randomIdToken(length = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

async function generateUniqueAccessId(role: 'admin' | 'operator'): Promise<string> {
  const prefix = role === 'admin' ? 'FBC-ADM' : 'FBC-OP';
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = `${prefix}-${randomAlphaNum(6)}`;
    const snap = await adminDb.collection('staff_credentials').doc(candidate).get();
    if (!snap.exists) {
      return candidate;
    }
  }
  return `${prefix}-${randomAlphaNum(8)}`;
}

function serializeFirestoreValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) {
    return value.toDate().toISOString() as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeFirestoreValue(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const maybeTs = value as { toDate?: () => Date };
    if (typeof maybeTs.toDate === 'function') {
      return maybeTs.toDate().toISOString() as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = serializeFirestoreValue(v);
      }
    }
    return out as T;
  }
  return value;
}

function sanitizeServerFirestore<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => sanitizeServerFirestore(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        clean[k] = sanitizeServerFirestore(v);
      }
    }
    return clean as T;
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms = 15000, label = 'Firestore'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT_${label}`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function isFirestoreIamError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === 7 ||
    code === 'permission-denied' ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('Missing or insufficient permissions') ||
    msg.includes('Could not load the default credentials')
  );
}

function handleServerApiError(res: express.Response, err: unknown, fallbackMsg: string) {
  console.error(fallbackMsg, err);
  if (res.headersSent) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('TIMEOUT_')) {
    res.status(504).json({
      error: `Délai de réponse dépassé lors de la communication avec Firestore (${firebaseConfig.projectId}). Vérifiez les identifiants serveur ou réessayez.`,
    });
    return;
  }
  if (isFirestoreIamError(err)) {
    res.status(503).json({
      error: `Accès Firestore côté serveur non autorisé sur le projet ${firebaseConfig.projectId}. Vérifiez que les identifiants serveur et le rôle roles/datastore.user sont bien configurés.`,
    });
    return;
  }
  res.status(500).json({ error: fallbackMsg });
}

function toPublicStaffCredential(docData: StaffCredentialDoc) {
  return {
    accessId: docData.accessId,
    displayName: docData.displayName,
    role: docData.role,
    active: docData.active,
    createdBy: docData.createdBy,
    lastLoginAt: docData.lastLoginAt || undefined,
    createdAt: serializeFirestoreValue(docData.createdAt) as string | undefined,
    updatedAt: serializeFirestoreValue(docData.updatedAt) as string | undefined,
  };
}

function normalizePhoneServer(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('226') && digits.length === 11) {
    return digits.slice(3);
  }
  return digits.slice(-8);
}

function buildLookupKeyServer(orderNumber: string, phone: string): string {
  const cleanOrder = orderNumber.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return `${cleanOrder}_${normalizePhoneServer(phone)}`;
}

async function writeServerAuditLog(params: {
  action: string;
  targetType: string;
  targetId: string;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
  details?: string;
}) {
  try {
    const logId = `log_${randomIdToken(12)}`;
    await adminDb
      .collection('audit_logs')
      .doc(logId)
      .set(
        sanitizeServerFirestore({
          logId,
          ...params,
          createdAt: FieldValue.serverTimestamp(),
        })
      );
  } catch (err) {
    console.warn('Server audit log write warning:', err);
  }
}

async function resolveServerStaffCaller(
  req: express.Request
): Promise<ResolvedStaffCaller | null> {
  // 1. Check Bearer Firebase ID Token (Google Sign-In)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.slice(7).trim();
    if (idToken) {
      try {
        const decoded = await adminAuth.verifyIdToken(idToken);
        const email = (decoded.email || '').toLowerCase();
        if (decoded.email_verified && email) {
          if (email === BOOTSTRAPPED_ADMIN_EMAIL) {
            return {
              uid: decoded.uid,
              actorEmail: email,
              actorRole: 'admin',
              displayName: decoded.name || 'Administrateur FBC Print',
              authMethod: 'google',
            };
          }
          const userSnap = await adminDb.collection('admin_users').doc(decoded.uid).get();
          if (userSnap.exists) {
            const data = userSnap.data() as {
              email?: string;
              role?: 'admin' | 'operator';
              active?: boolean;
              displayName?: string;
            };
            if (data.active && (data.role === 'admin' || data.role === 'operator')) {
              return {
                uid: decoded.uid,
                actorEmail: data.email || email,
                actorRole: data.role,
                displayName: data.displayName || email,
                authMethod: 'google',
              };
            }
          }
        }
      } catch (err) {
        if (isFirestoreIamError(err)) throw err;
        // Invalid/expired bearer token falls through to cookie check
      }
    }
  }

  // 2. Check signed staff credential session header (iframe-safe) or HttpOnly cookie
  const rawHeaderToken =
    typeof req.headers['x-staff-session'] === 'string'
      ? req.headers['x-staff-session'].trim()
      : authHeader && authHeader.startsWith('Staff ')
        ? authHeader.slice(6).trim()
        : '';
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifyStaffToken(rawHeaderToken || cookies[STAFF_COOKIE_NAME]);
  if (!payload) return null;

  const credSnap = await adminDb.collection('staff_credentials').doc(payload.accessId).get();
  if (!credSnap.exists) return null;
  const cred = credSnap.data() as StaffCredentialDoc;
  if (!cred.active) return null;

  return {
    uid: cred.accessId,
    actorEmail: `${cred.displayName} (${cred.accessId})`,
    actorRole: cred.role,
    displayName: cred.displayName,
    accessId: cred.accessId,
    authMethod: 'credentials',
  };
}

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
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Staff-Session'
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });
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

  // --- Server-Side Staff Authentication (Unique ID + Custom Password) & Admin API ---

  app.get('/api/staff/session', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.authMethod !== 'credentials') {
        res.json({ authenticated: false });
        return;
      }
      res.json({
        authenticated: true,
        user: {
          uid: caller.uid,
          email: caller.actorEmail,
          displayName: caller.displayName,
          role: caller.actorRole,
          active: true,
          accessId: caller.accessId,
          authMethod: 'credentials',
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de vérifier la session atelier.');
    }
  });

  app.post('/api/staff/login', async (req, res) => {
    try {
      const { accessId, password } = (req.body || {}) as {
        accessId?: string;
        password?: string;
      };
      const cleanId = (accessId || '').trim().toUpperCase();
      if (!cleanId || !password) {
        res.status(400).json({ error: 'Renseignez votre identifiant unique et votre mot de passe.' });
        return;
      }

      const docRef = adminDb.collection('staff_credentials').doc(cleanId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
        return;
      }

      const cred = snap.data() as StaffCredentialDoc;
      if (!cred.active) {
        res.status(403).json({ error: 'Cet accès atelier a été désactivé par l’administrateur.' });
        return;
      }

      const ok = verifyStaffPassword(password, cred.passwordSalt, cred.passwordHash);
      if (!ok) {
        res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
        return;
      }

      const nowIso = new Date().toISOString();
      await docRef.update({
        lastLoginAt: nowIso,
        updatedAt: nowIso,
      });

      const token = signStaffToken({
        accessId: cred.accessId,
        role: cred.role,
        displayName: cred.displayName,
        exp: Date.now() + SESSION_TTL_MS,
      });
      setStaffSessionCookie(req, res, token);

      await writeServerAuditLog({
        action: 'Connexion par identifiant',
        targetType: 'staff_credential',
        targetId: cred.accessId,
        actorEmail: `${cred.displayName} (${cred.accessId})`,
        actorRole: cred.role,
      });

      res.json({
        sessionToken: token,
        user: {
          uid: cred.accessId,
          email: `${cred.displayName} (${cred.accessId})`,
          displayName: cred.displayName,
          role: cred.role,
          active: true,
          accessId: cred.accessId,
          authMethod: 'credentials',
          lastLoginAt: nowIso,
          createdAt: serializeFirestoreValue(cred.createdAt) || nowIso,
        },
      });
    } catch (err) {
      handleServerApiError(res, err, 'Échec de la connexion atelier.');
    }
  });

  app.post('/api/staff/logout', (req, res) => {
    clearStaffSessionCookie(req, res);
    res.json({ ok: true });
  });

  // Admin-only: list generated staff credentials + legacy Google accounts
  app.get('/api/admin/staff-access', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }

      const [credSnap, usersSnap] = await Promise.all([
        adminDb.collection('staff_credentials').get(),
        adminDb.collection('admin_users').get(),
      ]);

      const credentials = credSnap.docs
        .map((d) => toPublicStaffCredential(d.data() as StaffCredentialDoc))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      const googleUsers = usersSnap.docs.map((d) =>
        serializeFirestoreValue(d.data())
      );

      res.json({ credentials, googleUsers });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de charger la liste des accès.');
    }
  });

  // Admin-only: generate unique ID & store hashed custom password strictly server-side
  app.post('/api/admin/staff-access', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }

      const { displayName, role, password } = (req.body || {}) as {
        displayName?: string;
        role?: 'admin' | 'operator';
        password?: string;
      };

      const cleanName = (displayName || '').trim();
      const targetRole: 'admin' | 'operator' = role === 'admin' ? 'admin' : 'operator';

      if (cleanName.length < 2 || cleanName.length > 120) {
        res.status(400).json({ error: 'Le nom du collaborateur doit contenir entre 2 et 120 caractères.' });
        return;
      }
      if (!password || password.trim().length < 6 || password.length > 128) {
        res.status(400).json({ error: 'Le mot de passe personnalisé doit contenir au moins 6 caractères.' });
        return;
      }

      const accessId = await withTimeout(
        generateUniqueAccessId(targetRole),
        15000,
        'generateAccessId'
      );
      const { salt, hash } = hashStaffPassword(password);
      const nowIso = new Date().toISOString();

      const record: StaffCredentialDoc = {
        accessId,
        displayName: cleanName,
        role: targetRole,
        passwordHash: hash,
        passwordSalt: salt,
        active: true,
        createdBy: caller.actorEmail,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await withTimeout(
        adminDb.collection('staff_credentials').doc(accessId).set(record),
        15000,
        'saveAccess'
      );

      void writeServerAuditLog({
        action: 'Création accès identifiant unique',
        targetType: 'staff_credential',
        targetId: accessId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `${cleanName} · Rôle : ${targetRole}`,
      });

      res.status(201).json({ access: toPublicStaffCredential(record) });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de générer cet accès.');
    }
  });

  // Admin-only: update role, active status, displayName or reset custom password
  app.patch('/api/admin/staff-access/:accessId', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }

      const accessId = (req.params.accessId || '').trim().toUpperCase();
      const docRef = adminDb.collection('staff_credentials').doc(accessId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Accès introuvable.' });
        return;
      }

      const current = snap.data() as StaffCredentialDoc;
      const { active, role, displayName, password } = (req.body || {}) as {
        active?: boolean;
        role?: 'admin' | 'operator';
        displayName?: string;
        password?: string;
      };

      if (caller.accessId === accessId && active === false) {
        res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre accès actif.' });
        return;
      }

      const updates: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      const changes: string[] = [];

      if (typeof active === 'boolean' && active !== current.active) {
        updates.active = active;
        changes.push(active ? 'Réactivé' : 'Désactivé');
      }
      if ((role === 'admin' || role === 'operator') && role !== current.role) {
        updates.role = role;
        changes.push(`Rôle → ${role}`);
      }
      if (typeof displayName === 'string' && displayName.trim().length >= 2) {
        updates.displayName = displayName.trim().slice(0, 120);
        changes.push('Nom mis à jour');
      }
      if (typeof password === 'string' && password.length > 0) {
        if (password.trim().length < 6 || password.length > 128) {
          res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
          return;
        }
        const { salt, hash } = hashStaffPassword(password);
        updates.passwordSalt = salt;
        updates.passwordHash = hash;
        changes.push('Mot de passe réinitialisé');
      }

      await docRef.update(updates);
      const updatedSnap = await docRef.get();

      await writeServerAuditLog({
        action: 'Mise à jour accès collaborateur',
        targetType: 'staff_credential',
        targetId: accessId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: changes.join(' · ') || 'Mise à jour',
      });

      res.json({
        access: toPublicStaffCredential(updatedSnap.data() as StaffCredentialDoc),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de modifier cet accès.');
    }
  });

  // Admin-only: delete a generated credential
  app.delete('/api/admin/staff-access/:accessId', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }

      const accessId = (req.params.accessId || '').trim().toUpperCase();
      if (caller.accessId === accessId) {
        res.status(400).json({ error: 'Vous ne pouvez pas supprimer l’accès avec lequel vous êtes connecté.' });
        return;
      }

      const docRef = adminDb.collection('staff_credentials').doc(accessId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Accès introuvable.' });
        return;
      }

      const targetData = snap.data() as StaffCredentialDoc;
      await docRef.delete();

      await writeServerAuditLog({
        action: 'Suppression accès collaborateur',
        targetType: 'staff_credential',
        targetId: accessId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `Collaborateur : ${targetData.displayName}`,
      });

      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de supprimer cet accès.');
    }
  });

  // Admin-only: toggle legacy Google user active/role
  app.patch('/api/admin/google-staff/:uid', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { uid } = req.params;
      const { active, role } = (req.body || {}) as {
        active?: boolean;
        role?: 'admin' | 'operator';
      };
      const userRef = adminDb.collection('admin_users').doc(uid);
      const snap = await userRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Compte Google introuvable.' });
        return;
      }
      const userData = snap.data() as { email?: string };
      if (userData.email === BOOTSTRAPPED_ADMIN_EMAIL) {
        res.status(400).json({ error: 'Le compte administrateur principal ne peut pas être désactivé.' });
        return;
      }
      const updates: Record<string, unknown> = {};
      if (typeof active === 'boolean') updates.active = active;
      if (role === 'admin' || role === 'operator') updates.role = role;
      await userRef.update(updates);
      await writeServerAuditLog({
        action: 'Mise à jour accès Google collaborateur',
        targetType: 'admin_user',
        targetId: uid,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `Rôle : ${role} · Actif : ${active}`,
      });
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de modifier ce compte.');
    }
  });

  // Staff Bootstrap Data (orders, payments, clients, and for admin: auditLogs)
  app.get('/api/admin/bootstrap', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentification atelier requise.' });
        return;
      }

      const [ordersSnap, paymentsSnap, clientsSnap, auditSnap] = await Promise.all([
        adminDb.collection('orders').orderBy('createdAt', 'desc').limit(200).get(),
        adminDb.collection('payments').orderBy('createdAt', 'desc').limit(200).get(),
        adminDb.collection('clients').orderBy('createdAt', 'desc').limit(200).get(),
        caller.actorRole === 'admin'
          ? adminDb.collection('audit_logs').orderBy('createdAt', 'desc').limit(200).get()
          : Promise.resolve(null),
      ]);

      res.json({
        orders: ordersSnap.docs.map((d) => serializeFirestoreValue(d.data())),
        payments: paymentsSnap.docs.map((d) => serializeFirestoreValue(d.data())),
        clients: clientsSnap.docs.map((d) => serializeFirestoreValue(d.data())),
        auditLogs: auditSnap ? auditSnap.docs.map((d) => serializeFirestoreValue(d.data())) : [],
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de charger les données atelier.');
    }
  });

  // Admin-only: query audit logs by date range
  app.get('/api/admin/audit-logs', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const startIso = String(req.query.start || '');
      const endIso = String(req.query.end || '');
      const maxResults = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
      const startDate = new Date(startIso);
      const endDate = new Date(endIso);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        res.status(400).json({ error: 'Plage de dates invalide.' });
        return;
      }
      const snap = await adminDb
        .collection('audit_logs')
        .where('createdAt', '>=', Timestamp.fromDate(startDate))
        .where('createdAt', '<=', Timestamp.fromDate(endDate))
        .orderBy('createdAt', 'desc')
        .limit(maxResults)
        .get();

      res.json({
        logs: snap.docs.map((d) => serializeFirestoreValue(d.data())),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de charger les journaux d’audit.');
    }
  });

  // Staff: create manual order
  app.post('/api/admin/orders', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentification atelier requise.' });
        return;
      }

      const payload = (req.body || {}) as Record<string, unknown>;
      const year = new Date().getFullYear();
      const counterRef = adminDb.collection('counters').doc('orders');

      const seq = await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const current = snap.exists
          ? (snap.data() as { lastOrderSeq: number; lastQuoteSeq: number; lastReceiptSeq: number })
          : { lastOrderSeq: 41, lastQuoteSeq: 41, lastReceiptSeq: 12 };
        const nextOrder = (current.lastOrderSeq || 0) + 1;
        const nextQuote = (current.lastQuoteSeq || 0) + 1;
        tx.set(counterRef, {
          lastOrderSeq: nextOrder,
          lastQuoteSeq: nextQuote,
          lastReceiptSeq: current.lastReceiptSeq || 0,
        });
        return { nextOrder, nextQuote };
      });

      const orderNumber = `CMD-${year}-${String(seq.nextOrder).padStart(4, '0')}`;
      const quoteNumber = `DEV-${year}-${String(seq.nextQuote).padStart(4, '0')}`;
      const trackingCode = `FBC-${randomAlphaNum(6)}`;
      const orderId = `ord_${randomIdToken(16)}`;
      const nowIso = new Date().toISOString();

      const orderDoc = sanitizeServerFirestore({
        ...payload,
        orderId,
        orderNumber,
        quoteNumber,
        trackingCode,
        paymentIds: [],
        statusHistory: [
          {
            status: payload.status || 'recue',
            label: 'Reçue',
            actor: caller.actorEmail,
            note: 'Commande manuelle enregistrée',
            timestamp: nowIso,
          },
        ],
        source: 'manual_admin',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const lookupKey = buildLookupKeyServer(
        orderNumber,
        String(payload.customerPhone || '')
      );

      await adminDb.runTransaction(async (tx) => {
        tx.set(adminDb.collection('orders').doc(orderId), orderDoc);
        tx.set(adminDb.collection('order_lookups').doc(lookupKey), {
          orderId,
          orderNumber,
          createdAt: FieldValue.serverTimestamp(),
        });
      });

      await writeServerAuditLog({
        action: 'Création commande manuelle',
        targetType: 'order',
        targetId: orderNumber,
        actorEmail: caller.actorEmail,
        actorRole: caller.actorRole,
        details: `Client : ${String(payload.customerName || '')}`,
      });

      res.status(201).json({ orderId, orderNumber, quoteNumber, trackingCode });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de créer la commande manuelle.');
    }
  });

  // Staff: update order status
  app.patch('/api/admin/orders/:orderId/status', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentification atelier requise.' });
        return;
      }
      const { orderId } = req.params;
      const { newStatus, statusLabel, note, correctionMessage, cancellationReason } =
        (req.body || {}) as {
          newStatus?: string;
          statusLabel?: string;
          note?: string;
          correctionMessage?: string;
          cancellationReason?: string;
        };
      if (!newStatus) {
        res.status(400).json({ error: 'Statut manquant.' });
        return;
      }

      const orderRef = adminDb.collection('orders').doc(orderId);
      const snap = await orderRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Commande introuvable.' });
        return;
      }
      const orderData = snap.data() as {
        orderNumber: string;
        statusHistory?: Array<Record<string, unknown>>;
      };

      const nowIso = new Date().toISOString();
      const nextHistory = [
        ...(orderData.statusHistory || []),
        {
          status: newStatus,
          label: statusLabel || newStatus,
          actor: caller.actorEmail,
          note: note || correctionMessage || cancellationReason || '',
          timestamp: nowIso,
        },
      ];

      const updates: Record<string, unknown> = {
        status: newStatus,
        statusHistory: nextHistory,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (correctionMessage !== undefined) updates.correctionRequestMessage = correctionMessage;
      if (cancellationReason !== undefined) updates.cancellationReason = cancellationReason;

      await orderRef.update(sanitizeServerFirestore(updates));
      await writeServerAuditLog({
        action: `Statut → ${statusLabel || newStatus}`,
        targetType: 'order',
        targetId: orderData.orderNumber,
        actorEmail: caller.actorEmail,
        actorRole: caller.actorRole,
        details: note || correctionMessage || cancellationReason || '',
      });

      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de mettre à jour le statut.');
    }
  });

  // Staff: update order planning/meta fields
  app.patch('/api/admin/orders/:orderId/fields', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentification atelier requise.' });
        return;
      }
      const { orderId } = req.params;
      const body = (req.body || {}) as Record<string, unknown>;
      const allowedKeys = [
        'internalNotes',
        'promisedDeliveryDate',
        'urgent',
        'urgentFee',
        ...(caller.actorRole === 'admin' ? ['discountAmount', 'totalAmount'] : []),
      ];
      const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      for (const k of allowedKeys) {
        if (k in body && body[k] !== undefined) {
          updates[k] = body[k];
        }
      }

      await adminDb
        .collection('orders')
        .doc(orderId)
        .update(sanitizeServerFirestore(updates));
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’enregistrer les informations.');
    }
  });

  // Admin-only: validate Mobile Money payment
  app.post('/api/admin/payments/:paymentId/validate', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { paymentId } = req.params;
      const paymentRef = adminDb.collection('payments').doc(paymentId);
      const paymentSnap = await paymentRef.get();
      if (!paymentSnap.exists) {
        res.status(404).json({ error: 'Paiement introuvable.' });
        return;
      }
      const payment = paymentSnap.data() as {
        paymentId: string;
        orderId: string;
        orderNumber: string;
        methodName: string;
        depositPhone: string;
        transactionRef?: string;
        declaredAmount: number;
        paymentType: string;
      };

      const orderRef = adminDb.collection('orders').doc(payment.orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        res.status(404).json({ error: 'Commande associée introuvable.' });
        return;
      }
      const order = orderSnap.data() as {
        orderId: string;
        orderNumber: string;
        customerName: string;
        customerPhone: string;
        isWhatsapp?: boolean;
        deliveryAddress?: string;
        paidAmount?: number;
        totalAmount: number;
        receiptNumber?: string;
        status: string;
        statusHistory?: Array<Record<string, unknown>>;
      };

      const nowIso = new Date().toISOString();
      const year = new Date().getFullYear();
      let receiptNumber = order.receiptNumber;
      if (!receiptNumber) {
        const counterRef = adminDb.collection('counters').doc('orders');
        const nextRec = await adminDb.runTransaction(async (tx) => {
          const snap = await tx.get(counterRef);
          const cur = snap.exists
            ? (snap.data() as { lastOrderSeq: number; lastQuoteSeq: number; lastReceiptSeq: number })
            : { lastOrderSeq: 41, lastQuoteSeq: 41, lastReceiptSeq: 12 };
          const n = (cur.lastReceiptSeq || 0) + 1;
          tx.set(counterRef, {
            lastOrderSeq: cur.lastOrderSeq || 0,
            lastQuoteSeq: cur.lastQuoteSeq || 0,
            lastReceiptSeq: n,
          });
          return n;
        });
        receiptNumber = `REC-${year}-${String(nextRec).padStart(4, '0')}`;
      }

      const newPaidAmount = (order.paidAmount || 0) + payment.declaredAmount;
      const newPaymentStatus =
        newPaidAmount >= order.totalAmount ? 'paye' : 'partiellement_paye';
      const nextStatus =
        order.status === 'recue' ||
        order.status === 'en_verification' ||
        order.status === 'en_attente_paiement'
          ? 'payee'
          : order.status;

      const nextHistory = [
        ...(order.statusHistory || []),
        {
          status: nextStatus,
          label: `Paiement validé (${payment.methodName})`,
          actor: caller.actorEmail,
          note: `${payment.declaredAmount} FCFA · Reçu ${receiptNumber}`,
          timestamp: nowIso,
        },
      ];

      await paymentRef.update({
        status: 'valide',
        validatedByEmail: caller.actorEmail,
        validatedAt: nowIso,
      });

      await orderRef.update({
        paidAmount: newPaidAmount,
        paymentStatus: newPaymentStatus,
        paymentRejectionReason: '',
        receiptNumber,
        status: nextStatus,
        latestPayment: {
          paymentId: payment.paymentId,
          methodName: payment.methodName,
          depositPhone: payment.depositPhone,
          transactionRef: payment.transactionRef || '',
          declaredAmount: payment.declaredAmount,
          paymentType: payment.paymentType,
          status: 'valide',
          validatedAt: nowIso,
          createdAt: nowIso,
        },
        statusHistory: nextHistory,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const compactPhone = normalizePhoneServer(order.customerPhone || '');
      const clientRef = adminDb
        .collection('clients')
        .doc(compactPhone || `cli_${randomIdToken(8)}`);
      const clientSnap = await clientRef.get();
      if (clientSnap.exists) {
        const prev = clientSnap.data() as { totalOrders?: number; totalSpent?: number };
        await clientRef.update({
          name: order.customerName,
          totalOrders: (prev.totalOrders || 0) + 1,
          totalSpent: (prev.totalSpent || 0) + payment.declaredAmount,
          lastOrderAt: nowIso,
        });
      } else {
        await clientRef.set({
          clientId: clientRef.id,
          name: order.customerName,
          phone: order.customerPhone,
          isWhatsapp: Boolean(order.isWhatsapp),
          address: order.deliveryAddress || '',
          notes: '',
          totalOrders: 1,
          totalSpent: payment.declaredAmount,
          lastOrderAt: nowIso,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      await writeServerAuditLog({
        action: 'Validation paiement',
        targetType: 'payment',
        targetId: payment.paymentId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `${order.orderNumber} · ${payment.declaredAmount} FCFA (${payment.methodName})`,
      });

      res.json({ ok: true, receiptNumber });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de valider ce paiement.');
    }
  });

  // Admin-only: reject Mobile Money payment
  app.post('/api/admin/payments/:paymentId/reject', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { paymentId } = req.params;
      const { reason } = (req.body || {}) as { reason?: string };
      if (!reason?.trim()) {
        res.status(400).json({ error: 'Motif de rejet requis.' });
        return;
      }

      const paymentRef = adminDb.collection('payments').doc(paymentId);
      const paymentSnap = await paymentRef.get();
      if (!paymentSnap.exists) {
        res.status(404).json({ error: 'Paiement introuvable.' });
        return;
      }
      const payment = paymentSnap.data() as {
        paymentId: string;
        orderId: string;
        orderNumber: string;
        methodName: string;
        depositPhone: string;
        transactionRef?: string;
        declaredAmount: number;
        paymentType: string;
      };

      const orderRef = adminDb.collection('orders').doc(payment.orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        res.status(404).json({ error: 'Commande introuvable.' });
        return;
      }
      const order = orderSnap.data() as {
        orderNumber: string;
        status: string;
        statusHistory?: Array<Record<string, unknown>>;
      };

      const nowIso = new Date().toISOString();
      const nextHistory = [
        ...(order.statusHistory || []),
        {
          status: order.status,
          label: 'Paiement rejeté',
          actor: caller.actorEmail,
          note: reason.trim(),
          timestamp: nowIso,
        },
      ];

      await paymentRef.update({
        status: 'rejete',
        rejectionReason: reason.trim(),
        validatedByEmail: caller.actorEmail,
        validatedAt: nowIso,
      });

      await orderRef.update({
        paymentStatus: 'rejete',
        paymentRejectionReason: reason.trim(),
        latestPayment: {
          paymentId: payment.paymentId,
          methodName: payment.methodName,
          depositPhone: payment.depositPhone,
          transactionRef: payment.transactionRef || '',
          declaredAmount: payment.declaredAmount,
          paymentType: payment.paymentType,
          status: 'rejete',
          rejectionReason: reason.trim(),
          validatedAt: nowIso,
          createdAt: nowIso,
        },
        statusHistory: nextHistory,
        updatedAt: FieldValue.serverTimestamp(),
      });

      await writeServerAuditLog({
        action: 'Rejet paiement',
        targetType: 'payment',
        targetId: payment.paymentId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `${order.orderNumber} · Motif : ${reason.trim()}`,
      });

      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de rejeter ce paiement.');
    }
  });

  // Staff: update client notes
  app.patch('/api/admin/clients/:clientId/notes', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentification atelier requise.' });
        return;
      }
      const { clientId } = req.params;
      const { notes } = (req.body || {}) as { notes?: string };
      await adminDb.collection('clients').doc(clientId).update({ notes: notes || '' });
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’enregistrer la note client.');
    }
  });

  // Admin-only: save/delete service
  app.put('/api/admin/services/:serviceId', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { serviceId } = req.params;
      const service = (req.body || {}) as Record<string, unknown>;
      await adminDb
        .collection('services')
        .doc(serviceId)
        .set(
          sanitizeServerFirestore({
            ...service,
            id: serviceId,
            updatedAt: new Date().toISOString(),
          })
        );
      await writeServerAuditLog({
        action: 'Mise à jour tarif / prestation',
        targetType: 'service',
        targetId: serviceId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `${String(service.name || '')} (${String(service.basePrice || 0)} FCFA)`,
      });
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de sauvegarder la prestation.');
    }
  });

  app.delete('/api/admin/services/:serviceId', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { serviceId } = req.params;
      await adminDb.collection('services').doc(serviceId).delete();
      await writeServerAuditLog({
        action: 'Suppression prestation',
        targetType: 'service',
        targetId: serviceId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
      });
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de supprimer la prestation.');
    }
  });

  // Admin-only: save payment method
  app.put('/api/admin/payment-methods/:methodId', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { methodId } = req.params;
      const method = (req.body || {}) as Record<string, unknown>;
      await adminDb
        .collection('payment_methods')
        .doc(methodId)
        .set(sanitizeServerFirestore({ ...method, id: methodId }));
      await writeServerAuditLog({
        action: 'Modification opérateur Mobile Money',
        targetType: 'payment_method',
        targetId: methodId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `${String(method.operatorName || '')} · ${String(method.phoneNumber || '')}`,
      });
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de sauvegarder l’opérateur.');
    }
  });

  // Admin-only: save shop settings
  app.put('/api/admin/settings', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const settings = (req.body || {}) as Record<string, unknown>;
      await adminDb
        .collection('settings')
        .doc('shop')
        .set(
          sanitizeServerFirestore({
            ...settings,
            updatedAt: new Date().toISOString(),
          })
        );
      await writeServerAuditLog({
        action: 'Modification réglages boutique',
        targetType: 'settings',
        targetId: 'shop',
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `Atelier ${settings.isOpen ? 'ouvert' : 'fermé'} · Acompte ${String(settings.depositPercent || 0)}%`,
      });
      res.json({ ok: true });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’enregistrer les réglages.');
    }
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

  // Express JSON / route error handler so uncaught errors never drop the socket (502)
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error('Express middleware error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erreur interne du serveur.' });
      }
    }
  );

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FBC Print server listening on http://localhost:${PORT}`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

startServer().catch((err) => {
  console.error('Failed to start FBC Print server:', err);
  process.exit(1);
});
