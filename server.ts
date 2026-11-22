import express from 'express';
import fs from 'fs';
import http from 'http';
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
const CLIENT_COOKIE_NAME = 'fbc_client_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CLIENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
  type?: 'staff';
  accessId: string;
  role: 'admin' | 'operator';
  displayName: string;
  exp: number;
}

interface ClientSessionPayload {
  type: 'client';
  accountId: string;
  username: string;
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

interface ClientAccountDoc {
  accountId: string;
  username: string;
  usernameLower: string;
  fullName: string;
  phone: string;
  phoneNormalized: string;
  passwordHash: string;
  passwordSalt: string;
  mustChangePassword?: boolean;
  active: boolean;
  lastLoginAt?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

interface ResolvedClientCaller {
  accountId: string;
  username: string;
  fullName: string;
  phone: string;
  phoneNormalized: string;
  mustChangePassword: boolean;
  active: boolean;
  lastLoginAt?: string;
  createdAt?: string;
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
  const data = Buffer.from(JSON.stringify({ ...payload, type: 'staff' }), 'utf-8').toString('base64url');
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
    if ((parsed.type && parsed.type !== 'staff') || !parsed.accessId || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function signClientToken(payload: Omit<ClientSessionPayload, 'type'>): string {
  const data = Buffer.from(
    JSON.stringify({ ...payload, type: 'client' } satisfies ClientSessionPayload),
    'utf-8'
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifyClientToken(token: string | undefined): ClientSessionPayload | null {
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
    ) as ClientSessionPayload;
    if (parsed.type !== 'client' || !parsed.accountId || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function appendSessionCookie(
  req: express.Request,
  res: express.Response,
  name: string,
  value: string,
  maxAgeMs: number
) {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() === 'https';
  const maxAgeSec = maxAgeMs <= 0 ? 0 : Math.floor(maxAgeMs / 1000);
  const attrs = isHttps
    ? `HttpOnly; Path=/; SameSite=None; Secure; Partitioned; Max-Age=${maxAgeSec}`
    : `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${attrs}`);
}

function setStaffSessionCookie(
  req: express.Request,
  res: express.Response,
  token: string
) {
  appendSessionCookie(req, res, STAFF_COOKIE_NAME, token, SESSION_TTL_MS);
}

function clearStaffSessionCookie(req: express.Request, res: express.Response) {
  appendSessionCookie(req, res, STAFF_COOKIE_NAME, '', 0);
}

function setClientSessionCookie(
  req: express.Request,
  res: express.Response,
  token: string
) {
  appendSessionCookie(req, res, CLIENT_COOKIE_NAME, token, CLIENT_SESSION_TTL_MS);
}

function clearClientSessionCookie(req: express.Request, res: express.Response) {
  appendSessionCookie(req, res, CLIENT_COOKIE_NAME, '', 0);
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

function toPublicClientAccount(docData: ClientAccountDoc): ResolvedClientCaller {
  return {
    accountId: docData.accountId,
    username: docData.username,
    fullName: docData.fullName,
    phone: docData.phone,
    phoneNormalized: docData.phoneNormalized,
    mustChangePassword: Boolean(docData.mustChangePassword),
    active: Boolean(docData.active),
    lastLoginAt: docData.lastLoginAt || undefined,
    createdAt: serializeFirestoreValue(docData.createdAt) as string | undefined,
  };
}

function normalizePhoneServer(input: string): string {
  const digits = input.replace(/\D/g, '');
  let local = digits;
  if (digits.startsWith('226') && digits.length === 11) {
    local = digits.slice(3);
  } else if (digits.startsWith('00226') && digits.length === 13) {
    local = digits.slice(5);
  }
  if (local.length !== 8) {
    return digits;
  }
  return `226${local}`;
}

function formatNormalizedBurkinaPhone(phoneNormalized: string): string {
  if (phoneNormalized.length === 11 && phoneNormalized.startsWith('226')) {
    const local = phoneNormalized.slice(3);
    return `+226 ${local.slice(0, 2)} ${local.slice(2, 4)} ${local.slice(4, 6)} ${local.slice(6, 8)}`;
  }
  return `+${phoneNormalized}`;
}

function buildLookupKeyServer(trackingCode: string, phone: string): string {
  const cleanCode = trackingCode.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return `${cleanCode}_${normalizePhoneServer(phone)}`;
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

async function resolveServerClientCaller(
  req: express.Request
): Promise<ResolvedClientCaller | null> {
  const authHeader = req.headers.authorization;
  const bearerTwoPart =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
  const rawHeaderToken =
    typeof req.headers['x-client-session'] === 'string'
      ? req.headers['x-client-session'].trim()
      : bearerTwoPart && bearerTwoPart.split('.').length === 2
        ? bearerTwoPart
        : '';

  const cookies = parseCookies(req.headers.cookie);
  const payload = verifyClientToken(rawHeaderToken || cookies[CLIENT_COOKIE_NAME]);
  if (!payload) return null;

  const accSnap = await adminDb.collection('client_accounts').doc(payload.accountId).get();
  if (!accSnap.exists) return null;
  const acc = accSnap.data() as ClientAccountDoc;
  if (!acc.active) return null;
  return toPublicClientAccount(acc);
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
  purpose?: 'order_file' | 'payment_proof' | 'service_image';
  isPublicAsset?: boolean;
  ownerClientAccountId?: string;
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
        'Content-Type, Authorization, X-Staff-Session, X-Client-Session'
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

  async function isFileReferencedByCatalogService(fileId: string): Promise<boolean> {
    try {
      const previewPath = `/api/files/${fileId}/preview`;
      const snap = await adminDb
        .collection('services')
        .where('imageUrl', '==', previewPath)
        .limit(1)
        .get();
      return !snap.empty;
    } catch {
      return false;
    }
  }

  async function doesClientOwnFile(clientAccountId: string, fileId: string): Promise<boolean> {
    const ordersSnap = await adminDb
      .collection('orders')
      .where('clientAccountId', '==', clientAccountId)
      .get();
    const ownedOrderIds = new Set<string>();
    for (const d of ordersSnap.docs) {
      const ord = d.data() as {
        orderId?: string;
        files?: Array<{ fileId?: string }>;
      };
      if (ord.orderId) ownedOrderIds.add(ord.orderId);
      if (Array.isArray(ord.files) && ord.files.some((f) => f.fileId === fileId)) {
        return true;
      }
    }
    if (ownedOrderIds.size > 0) {
      const paySnap = await adminDb
        .collection('payments')
        .where('screenshotFileId', '==', fileId)
        .limit(5)
        .get();
      for (const pDoc of paySnap.docs) {
        const pay = pDoc.data() as { orderId?: string };
        if (pay.orderId && ownedOrderIds.has(pay.orderId)) {
          return true;
        }
      }
    }
    return false;
  }

  async function authorizeStoredFileRequest(
    req: express.Request,
    res: express.Response,
    record: StoredFileRecord
  ): Promise<boolean> {
    if (record.isPublicAsset || record.purpose === 'service_image') {
      return true;
    }
    // Backward compatibility for service catalog thumbnails uploaded before isPublicAsset existed
    if (!record.purpose && !record.ownerClientAccountId) {
      const isCatalogImg = await isFileReferencedByCatalogService(record.fileId);
      if (isCatalogImg) {
        record.isPublicAsset = true;
        record.purpose = 'service_image';
        saveIndex(uploadsIndex);
        return true;
      }
    }

    const staff = await resolveServerStaffCaller(req).catch(() => null);
    if (staff) return true;

    const client = await resolveServerClientCaller(req).catch(() => null);
    if (!client) {
      res.status(401).json({ error: 'Authentification requise pour accéder à ce fichier.' });
      return false;
    }

    if (record.ownerClientAccountId === client.accountId) {
      return true;
    }

    const ownsViaOrder = await doesClientOwnFile(client.accountId, record.fileId);
    if (ownsViaOrder) {
      if (!record.ownerClientAccountId) {
        record.ownerClientAccountId = client.accountId;
        saveIndex(uploadsIndex);
      }
      return true;
    }

    res.status(403).json({ error: 'Accès interdit à un fichier appartenant à un autre client.' });
    return false;
  }

  // 1. Initialize a chunked resumable upload (no compression)
  app.post('/api/uploads/init', async (req, res) => {
    try {
      const { fileName, totalSize, mimeType, purpose } = (req.body || {}) as {
        fileName?: string;
        totalSize?: number;
        mimeType?: string;
        purpose?: 'order_file' | 'payment_proof' | 'service_image';
      };

      const resolvedPurpose: 'order_file' | 'payment_proof' | 'service_image' =
        purpose === 'service_image'
          ? 'service_image'
          : purpose === 'payment_proof'
            ? 'payment_proof'
            : 'order_file';

      const staff = await resolveServerStaffCaller(req).catch(() => null);
      const client = staff ? null : await resolveServerClientCaller(req).catch(() => null);

      if (resolvedPurpose === 'service_image') {
        if (!staff) {
          res.status(403).json({ error: 'Authentification atelier requise pour importer une image de prestation.' });
          return;
        }
      } else if (!staff && !client) {
        res.status(401).json({ error: 'Veuillez vous connecter à votre compte client avant d’envoyer vos fichiers.' });
        return;
      }

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
        purpose: resolvedPurpose,
        isPublicAsset: resolvedPurpose === 'service_image',
        ...(client ? { ownerClientAccountId: client.accountId } : {}),
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
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’initialiser le transfert.');
    }
  });

  async function canMutateUpload(
    req: express.Request,
    res: express.Response,
    record: StoredFileRecord
  ): Promise<boolean> {
    const staff = await resolveServerStaffCaller(req).catch(() => null);
    if (staff) return true;
    if (record.purpose === 'service_image') {
      res.status(403).json({ error: 'Authentification atelier requise.' });
      return false;
    }
    const client = await resolveServerClientCaller(req).catch(() => null);
    if (!client) {
      res.status(401).json({ error: 'Authentification client requise.' });
      return false;
    }
    if (record.ownerClientAccountId && record.ownerClientAccountId !== client.accountId) {
      res.status(403).json({ error: 'Accès interdit à ce transfert.' });
      return false;
    }
    return true;
  }

  // 2. Check upload status for automatic resume after network drop
  app.get('/api/uploads/:fileId/status', async (req, res) => {
    const record = uploadsIndex[req.params.fileId];
    if (!record) {
      res.status(404).json({ error: 'Session de transfert introuvable.' });
      return;
    }
    if (!(await canMutateUpload(req, res, record))) return;
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
    async (req, res) => {
      const record = uploadsIndex[req.params.fileId];
      if (!record) {
        res.status(404).json({ error: 'Session de transfert introuvable.' });
        return;
      }
      if (!(await canMutateUpload(req, res, record))) return;

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
    if (!(await canMutateUpload(req, res, record))) return;

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

  // 5. Download original uncompressed file byte-for-byte (staff or owning client only)
  app.get('/api/files/:fileId/download', async (req, res) => {
    try {
      const record = uploadsIndex[req.params.fileId];
      if (!record || !record.complete) {
        res.status(404).json({ error: 'Fichier introuvable.' });
        return;
      }
      if (!(await authorizeStoredFileRequest(req, res, record))) return;

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
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de télécharger ce fichier.');
    }
  });

  // 6. Preview file inline (images & PDFs; public only for catalog images, otherwise staff/owner)
  app.get('/api/files/:fileId/preview', async (req, res) => {
    try {
      const record = uploadsIndex[req.params.fileId];
      if (!record || !record.complete) {
        res.status(404).json({ error: 'Aperçu indisponible.' });
        return;
      }
      if (!(await authorizeStoredFileRequest(req, res, record))) return;

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
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’afficher cet aperçu.');
    }
  });

  // 7. Bundle all original files of an order into a single ZIP without recompression (staff or owner)
  app.post('/api/orders/:orderId/files-zip', async (req, res) => {
    try {
      const staff = await resolveServerStaffCaller(req).catch(() => null);
      const client = staff ? null : await resolveServerClientCaller(req).catch(() => null);
      if (!staff && !client) {
        res.status(401).json({ error: 'Authentification requise pour télécharger cette archive.' });
        return;
      }

      const orderSnap = await adminDb.collection('orders').doc(req.params.orderId).get();
      if (!orderSnap.exists) {
        res.status(404).json({ error: 'Commande introuvable.' });
        return;
      }
      const orderData = orderSnap.data() as {
        clientAccountId?: string;
        orderNumber?: string;
        files?: Array<{ fileId: string; originalName?: string; slotLabel?: string; replaced?: boolean }>;
      };

      if (!staff && client && orderData.clientAccountId !== client.accountId) {
        res.status(403).json({ error: 'Accès interdit aux fichiers d’une autre commande.' });
        return;
      }

      const { files, orderNumber } = (req.body || {}) as {
        files?: Array<{ fileId: string; originalName?: string; slotLabel?: string }>;
        orderNumber?: string;
      };

      const requestedList =
        Array.isArray(files) && files.length > 0
          ? files
          : (orderData.files || []).filter((f) => !f.replaced);

      if (requestedList.length === 0) {
        res.status(400).json({ error: 'Aucun fichier à archiver.' });
        return;
      }

      const allowedOrderFileIds = new Set((orderData.files || []).map((f) => f.fileId));
      const entries: Array<{ targetPath: string; entryName: string }> = [];
      const usedNames = new Set<string>();
      for (const item of requestedList) {
        if (!allowedOrderFileIds.has(item.fileId)) continue;
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

      const archiveName = `${orderNumber || orderData.orderNumber || req.params.orderId}_fichiers_originaux.zip`;
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
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de générer l’archive ZIP.');
    }
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

      const normalizedPhone = normalizePhoneServer(String(payload.customerPhone || ''));
      let matchedClientAccountId =
        typeof payload.clientAccountId === 'string' && payload.clientAccountId.trim()
          ? payload.clientAccountId.trim()
          : undefined;
      if (!matchedClientAccountId && normalizedPhone.length === 11) {
        const accSnap = await adminDb
          .collection('client_accounts')
          .where('phoneNormalized', '==', normalizedPhone)
          .limit(1)
          .get();
        if (!accSnap.empty) {
          matchedClientAccountId = accSnap.docs[0].id;
        }
      }

      const orderDoc = sanitizeServerFirestore({
        ...payload,
        ...(matchedClientAccountId ? { clientAccountId: matchedClientAccountId } : {}),
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
        trackingCode,
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

      res.status(201).json({
        orderId,
        orderNumber,
        quoteNumber,
        trackingCode,
        order: serializeFirestoreValue({ ...orderDoc, createdAt: nowIso, updatedAt: nowIso }),
      });
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

  // --- Server-Side Client Accounts, Authenticated Order Workspace & Privacy Enforcement ---

  const clientAttemptsByIp = new Map<string, number[]>();
  function isClientRateLimited(req: express.Request, maxHits = 25, windowMs = 5 * 60 * 1000): boolean {
    const ip =
      req.ip ||
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : 'unknown');
    const now = Date.now();
    const recent = (clientAttemptsByIp.get(ip) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= maxHits) return true;
    recent.push(now);
    if (clientAttemptsByIp.size > 500) {
      for (const [key, timestamps] of clientAttemptsByIp.entries()) {
        if (!timestamps.some((ts) => now - ts < windowMs)) {
          clientAttemptsByIp.delete(key);
        }
      }
    }
    clientAttemptsByIp.set(ip, recent);
    return false;
  }

  function validateUsername(raw: unknown): { valid: boolean; clean: string; lower: string; error?: string } {
    if (typeof raw !== 'string') {
      return { valid: false, clean: '', lower: '', error: 'Nom d’utilisateur requis.' };
    }
    const clean = raw.trim();
    if (!/^[a-zA-Z0-9._-]{3,30}$/.test(clean)) {
      return {
        valid: false,
        clean,
        lower: clean.toLowerCase(),
        error: 'Le nom d’utilisateur doit contenir entre 3 et 30 caractères (lettres, chiffres, ".", "_" ou "-").',
      };
    }
    return { valid: true, clean, lower: clean.toLowerCase() };
  }

  function bindOrderFilesToClient(files: unknown, accountId: string) {
    if (!Array.isArray(files)) return;
    let mutated = false;
    for (const f of files) {
      const fid = f && typeof f === 'object' ? (f as { fileId?: unknown }).fileId : null;
      if (typeof fid === 'string' && uploadsIndex[fid] && !uploadsIndex[fid].ownerClientAccountId) {
        uploadsIndex[fid].ownerClientAccountId = accountId;
        mutated = true;
      }
    }
    if (mutated) saveIndex(uploadsIndex);
  }

  async function attachOrVerifyTrackingCode(
    caller: { accountId: string; phoneNormalized: string },
    rawTrackingCode: string
  ): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
    order?: Record<string, unknown>;
    claimed?: boolean;
  }> {
    const cleanCode = rawTrackingCode.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleanCode.startsWith('CMD-')) {
      return {
        ok: false,
        status: 400,
        error: 'Le suivi s’effectue avec votre code de suivi (ex : FBC-A7K9M2) et non avec le numéro de commande.',
      };
    }
    if (!/^FBC-[A-Z0-9]{4,12}$/.test(cleanCode)) {
      return { ok: false, status: 400, error: 'Format du code de suivi invalide.' };
    }

    const snap = await adminDb
      .collection('orders')
      .where('trackingCode', '==', cleanCode)
      .limit(5)
      .get();

    if (snap.empty) {
      return { ok: false, status: 404, error: 'Aucune commande trouvée avec ce code de suivi.' };
    }

    const docSnap = snap.docs[0];
    const orderData = docSnap.data() as Record<string, unknown>;
    const existingOwner = typeof orderData.clientAccountId === 'string' ? orderData.clientAccountId : '';

    if (existingOwner && existingOwner !== caller.accountId) {
      return {
        ok: false,
        status: 403,
        error: 'Accès refusé : cette commande appartient à un autre compte client.',
      };
    }

    if (!existingOwner) {
      const orderPhoneNorm = normalizePhoneServer(String(orderData.customerPhone || ''));
      if (orderPhoneNorm !== caller.phoneNormalized) {
        return {
          ok: false,
          status: 403,
          error: 'Accès refusé : ce code de suivi est associé à un autre numéro de téléphone.',
        };
      }
      await docSnap.ref.update({
        clientAccountId: caller.accountId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      bindOrderFilesToClient(orderData.files, caller.accountId);
      const updated = { ...orderData, clientAccountId: caller.accountId };
      return { ok: true, order: serializeFirestoreValue(updated), claimed: true };
    }

    bindOrderFilesToClient(orderData.files, caller.accountId);
    return { ok: true, order: serializeFirestoreValue(orderData), claimed: false };
  }

  // Client session probe
  app.get('/api/client/session', async (req, res) => {
    try {
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.json({ authenticated: false });
        return;
      }
      res.json({ authenticated: true, account: caller });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de vérifier votre session client.');
    }
  });

  // Client registration
  app.post('/api/client/register', async (req, res) => {
    try {
      if (isClientRateLimited(req, 15)) {
        res.status(429).json({ error: 'Trop de tentatives. Veuillez patienter quelques minutes.' });
        return;
      }

      const { username, fullName, phone, password, claimTrackingCode } = (req.body || {}) as {
        username?: unknown;
        fullName?: unknown;
        phone?: unknown;
        password?: unknown;
        claimTrackingCode?: unknown;
      };

      const userCheck = validateUsername(username);
      if (!userCheck.valid) {
        res.status(400).json({ error: userCheck.error });
        return;
      }

      const cleanFullName = typeof fullName === 'string' ? fullName.trim() : '';
      if (cleanFullName.length < 2 || cleanFullName.length > 120) {
        res.status(400).json({ error: 'Le nom complet doit contenir entre 2 et 120 caractères.' });
        return;
      }

      const phoneNorm = normalizePhoneServer(typeof phone === 'string' ? phone : '');
      if (phoneNorm.length !== 11 || !phoneNorm.startsWith('226')) {
        res.status(400).json({ error: 'Numéro de téléphone Burkina Faso (+226, 8 chiffres) invalide.' });
        return;
      }
      const formattedPhone = formatNormalizedBurkinaPhone(phoneNorm);

      if (typeof password !== 'string' || password.trim().length < 6 || password.length > 128) {
        res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
        return;
      }

      const [existingUserSnap, existingPhoneSnap] = await Promise.all([
        adminDb.collection('client_accounts').where('usernameLower', '==', userCheck.lower).limit(1).get(),
        adminDb.collection('client_accounts').where('phoneNormalized', '==', phoneNorm).limit(1).get(),
      ]);

      if (!existingUserSnap.empty) {
        res.status(409).json({ error: 'Ce nom d’utilisateur est déjà utilisé.' });
        return;
      }
      if (!existingPhoneSnap.empty) {
        res.status(409).json({
          error: 'Un compte client existe déjà avec ce numéro de téléphone. Connectez-vous.',
        });
        return;
      }

      const accountId = `cliacc_${randomIdToken(14)}`;
      const cleanClaim = typeof claimTrackingCode === 'string' ? claimTrackingCode.trim() : '';
      if (cleanClaim) {
        // Verify claim eligibility before creating the account
        const checkSnap = await adminDb
          .collection('orders')
          .where('trackingCode', '==', cleanClaim.toUpperCase().replace(/[^A-Z0-9-]/g, ''))
          .limit(5)
          .get();
        if (checkSnap.empty) {
          res.status(404).json({ error: 'Le code de suivi indiqué est introuvable.' });
          return;
        }
        const checkOrder = checkSnap.docs[0].data() as Record<string, unknown>;
        if (typeof checkOrder.clientAccountId === 'string' && checkOrder.clientAccountId) {
          res.status(403).json({ error: 'Cette commande est déjà rattachée à un compte client.' });
          return;
        }
        if (normalizePhoneServer(String(checkOrder.customerPhone || '')) !== phoneNorm) {
          res.status(403).json({
            error: 'Le code de suivi indiqué ne correspond pas à votre numéro de téléphone.',
          });
          return;
        }
      }

      const { salt, hash } = hashStaffPassword(password);
      const nowIso = new Date().toISOString();
      const accountDoc: ClientAccountDoc = {
        accountId,
        username: userCheck.clean,
        usernameLower: userCheck.lower,
        fullName: cleanFullName,
        phone: formattedPhone,
        phoneNormalized: phoneNorm,
        passwordHash: hash,
        passwordSalt: salt,
        mustChangePassword: false,
        active: true,
        lastLoginAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await adminDb.collection('client_accounts').doc(accountId).set(accountDoc);

      let claimedOrder: Record<string, unknown> | undefined;
      if (cleanClaim) {
        const resClaim = await attachOrVerifyTrackingCode({ accountId, phoneNormalized: phoneNorm }, cleanClaim);
        if (resClaim.ok && resClaim.order) {
          claimedOrder = resClaim.order;
        }
      }

      const token = signClientToken({
        accountId,
        username: accountDoc.username,
        exp: Date.now() + CLIENT_SESSION_TTL_MS,
      });
      setClientSessionCookie(req, res, token);

      res.status(201).json({
        sessionToken: token,
        account: toPublicClientAccount(accountDoc),
        ...(claimedOrder ? { claimedOrder } : {}),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de créer votre compte client.');
    }
  });

  // Client login (Phone OR Username + Password)
  app.post('/api/client/login', async (req, res) => {
    try {
      if (isClientRateLimited(req, 20)) {
        res.status(429).json({ error: 'Trop de tentatives. Veuillez patienter quelques minutes.' });
        return;
      }

      const { identifier, password } = (req.body || {}) as {
        identifier?: unknown;
        password?: unknown;
      };
      const cleanId = typeof identifier === 'string' ? identifier.trim() : '';
      if (!cleanId || typeof password !== 'string' || !password) {
        res.status(400).json({ error: 'Renseignez votre téléphone (ou nom d’utilisateur) et votre mot de passe.' });
        return;
      }

      let foundSnap = await adminDb
        .collection('client_accounts')
        .where('usernameLower', '==', cleanId.toLowerCase())
        .limit(1)
        .get();

      if (foundSnap.empty) {
        const normPhone = normalizePhoneServer(cleanId);
        if (normPhone.length === 11 && normPhone.startsWith('226')) {
          foundSnap = await adminDb
            .collection('client_accounts')
            .where('phoneNormalized', '==', normPhone)
            .limit(1)
            .get();
        }
      }

      if (foundSnap.empty) {
        res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
        return;
      }

      const docSnap = foundSnap.docs[0];
      const account = docSnap.data() as ClientAccountDoc;
      if (!account.active) {
        res.status(403).json({
          error: 'Ce compte client a été désactivé. Contactez l’atelier FBC Print.',
        });
        return;
      }

      const ok = verifyStaffPassword(password, account.passwordSalt, account.passwordHash);
      if (!ok) {
        res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
        return;
      }

      const nowIso = new Date().toISOString();
      await docSnap.ref.update({
        lastLoginAt: nowIso,
        updatedAt: nowIso,
      });

      const token = signClientToken({
        accountId: account.accountId,
        username: account.username,
        exp: Date.now() + CLIENT_SESSION_TTL_MS,
      });
      setClientSessionCookie(req, res, token);

      res.json({
        sessionToken: token,
        account: toPublicClientAccount({ ...account, lastLoginAt: nowIso }),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de vous connecter.');
    }
  });

  app.post('/api/client/logout', (req, res) => {
    clearClientSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/client/change-password', async (req, res) => {
    try {
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise.' });
        return;
      }
      const { currentPassword, newPassword } = (req.body || {}) as {
        currentPassword?: unknown;
        newPassword?: unknown;
      };
      if (typeof currentPassword !== 'string' || !currentPassword) {
        res.status(400).json({ error: 'Saisissez votre mot de passe actuel.' });
        return;
      }
      if (typeof newPassword !== 'string' || newPassword.trim().length < 6 || newPassword.length > 128) {
        res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
        return;
      }

      const docRef = adminDb.collection('client_accounts').doc(caller.accountId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Compte introuvable.' });
        return;
      }
      const account = snap.data() as ClientAccountDoc;
      if (!verifyStaffPassword(currentPassword, account.passwordSalt, account.passwordHash)) {
        res.status(401).json({ error: 'Le mot de passe actuel est incorrect.' });
        return;
      }

      const { salt, hash } = hashStaffPassword(newPassword);
      const nowIso = new Date().toISOString();
      await docRef.update({
        passwordHash: hash,
        passwordSalt: salt,
        mustChangePassword: false,
        updatedAt: nowIso,
      });

      res.json({
        account: { ...caller, mustChangePassword: false },
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de modifier votre mot de passe.');
    }
  });

  // Client orders list (strictly isolated to caller.accountId)
  app.get('/api/client/orders', async (req, res) => {
    try {
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise.' });
        return;
      }
      const snap = await adminDb
        .collection('orders')
        .where('clientAccountId', '==', caller.accountId)
        .get();

      const orders = snap.docs
        .map((d) => serializeFirestoreValue(d.data()) as Record<string, unknown>)
        .sort((a, b) =>
          String(b.createdAt || b.createdAtIso || '').localeCompare(
            String(a.createdAt || a.createdAtIso || '')
          )
        );
      res.json({ orders });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de charger vos commandes.');
    }
  });

  // Attach an unowned/manual order by trackingCode (phone must match caller)
  app.post('/api/client/claim-order', async (req, res) => {
    try {
      if (isClientRateLimited(req, 20)) {
        res.status(429).json({ error: 'Trop de tentatives. Veuillez patienter quelques minutes.' });
        return;
      }
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise.' });
        return;
      }
      const { trackingCode } = (req.body || {}) as { trackingCode?: unknown };
      if (typeof trackingCode !== 'string' || !trackingCode.trim()) {
        res.status(400).json({ error: 'Code de suivi requis.' });
        return;
      }

      const result = await attachOrVerifyTrackingCode(caller, trackingCode);
      if (!result.ok) {
        res.status(result.status || 400).json({ error: result.error });
        return;
      }
      res.json({ order: result.order, claimed: Boolean(result.claimed) });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de rattacher cette commande.');
    }
  });

  // Open a shared tracking link (?code=FBC-...) strictly for the authenticated owning client
  app.post('/api/client/orders/open-link', async (req, res) => {
    try {
      if (isClientRateLimited(req, 25)) {
        res.status(429).json({ error: 'Trop de tentatives. Veuillez patienter quelques minutes.' });
        return;
      }
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise pour consulter cette commande.' });
        return;
      }
      const { trackingCode } = (req.body || {}) as { trackingCode?: unknown };
      if (typeof trackingCode !== 'string' || !trackingCode.trim()) {
        res.status(400).json({ error: 'Code de suivi requis.' });
        return;
      }

      const result = await attachOrVerifyTrackingCode(caller, trackingCode);
      if (!result.ok) {
        res.status(result.status || 400).json({ error: result.error });
        return;
      }
      res.json({ order: result.order, claimed: Boolean(result.claimed) });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’ouvrir ce lien de commande.');
    }
  });

  // Authenticated client creates an order
  app.post('/api/client/orders', async (req, res) => {
    try {
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise pour valider votre commande.' });
        return;
      }

      const payload = (req.body || {}) as Record<string, unknown>;
      if (!Array.isArray(payload.items) || payload.items.length === 0) {
        res.status(400).json({ error: 'La commande doit contenir au moins une prestation.' });
        return;
      }
      if (!payload.acceptedTerms) {
        res.status(400).json({ error: 'Veuillez accepter les conditions de commande.' });
        return;
      }

      const filesList = Array.isArray(payload.files) ? payload.files : [];
      for (const f of filesList) {
        const fid = f && typeof f === 'object' ? (f as { fileId?: unknown }).fileId : null;
        if (typeof fid === 'string' && uploadsIndex[fid]) {
          const owner = uploadsIndex[fid].ownerClientAccountId;
          if (owner && owner !== caller.accountId) {
            res.status(403).json({ error: 'Fichier associé à un autre compte client.' });
            return;
          }
        }
      }

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

      const customerName =
        typeof payload.customerName === 'string' && payload.customerName.trim().length >= 2
          ? payload.customerName.trim().slice(0, 120)
          : caller.fullName;
      const customerPhone =
        typeof payload.customerPhone === 'string' && normalizePhoneServer(payload.customerPhone).length === 11
          ? formatNormalizedBurkinaPhone(normalizePhoneServer(payload.customerPhone))
          : caller.phone;

      const orderDoc = sanitizeServerFirestore({
        ...payload,
        orderId,
        orderNumber,
        quoteNumber,
        trackingCode,
        clientAccountId: caller.accountId,
        customerName,
        customerPhone,
        paymentIds: [],
        status: 'recue',
        paymentStatus: 'non_paye',
        paidAmount: 0,
        discountAmount: 0,
        statusHistory: [
          {
            status: 'recue',
            label: 'Reçue',
            actor: customerName,
            note: 'Commande enregistrée',
            timestamp: nowIso,
          },
        ],
        source: 'web',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const lookupKey = buildLookupKeyServer(trackingCode, customerPhone);
      await adminDb.runTransaction(async (tx) => {
        tx.set(adminDb.collection('orders').doc(orderId), orderDoc);
        tx.set(adminDb.collection('order_lookups').doc(lookupKey), {
          orderId,
          orderNumber,
          createdAt: FieldValue.serverTimestamp(),
        });
      });

      bindOrderFilesToClient(filesList, caller.accountId);

      res.status(201).json({
        order: serializeFirestoreValue({
          ...orderDoc,
          createdAt: nowIso,
          updatedAt: nowIso,
          createdAtIso: nowIso,
        }),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’enregistrer votre commande.');
    }
  });

  // Authenticated client declares a payment on their own order
  app.post('/api/client/orders/:orderId/payments', async (req, res) => {
    try {
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise.' });
        return;
      }

      const orderRef = adminDb.collection('orders').doc(req.params.orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        res.status(404).json({ error: 'Commande introuvable.' });
        return;
      }
      const orderData = orderSnap.data() as Record<string, unknown>;
      if (orderData.clientAccountId !== caller.accountId) {
        res.status(403).json({ error: 'Accès refusé à cette commande.' });
        return;
      }

      const {
        methodId,
        methodName,
        depositPhone,
        transactionRef,
        declaredAmount,
        paymentType,
        screenshotFileId,
        screenshotPreviewUrl,
      } = (req.body || {}) as {
        methodId?: string;
        methodName?: string;
        depositPhone?: string;
        transactionRef?: string;
        declaredAmount?: number;
        paymentType?: 'acompte' | 'integral' | 'solde';
        screenshotFileId?: string;
        screenshotPreviewUrl?: string;
      };

      if (!methodId || !methodName || !depositPhone || typeof declaredAmount !== 'number' || declaredAmount <= 0) {
        res.status(400).json({ error: 'Informations de paiement invalides.' });
        return;
      }
      if (paymentType !== 'acompte' && paymentType !== 'integral' && paymentType !== 'solde') {
        res.status(400).json({ error: 'Type de paiement invalide.' });
        return;
      }

      if (screenshotFileId && uploadsIndex[screenshotFileId]) {
        const owner = uploadsIndex[screenshotFileId].ownerClientAccountId;
        if (owner && owner !== caller.accountId) {
          res.status(403).json({ error: 'Capture de paiement invalide.' });
          return;
        }
        if (!owner) {
          uploadsIndex[screenshotFileId].ownerClientAccountId = caller.accountId;
          saveIndex(uploadsIndex);
        }
      }

      const paymentId = `pay_${randomIdToken(14)}`;
      const nowIso = new Date().toISOString();

      const paymentDoc = sanitizeServerFirestore({
        paymentId,
        orderId: String(orderData.orderId),
        orderNumber: String(orderData.orderNumber),
        customerName: String(orderData.customerName),
        methodId,
        methodName,
        depositPhone: depositPhone.trim(),
        transactionRef: (transactionRef || '').trim(),
        declaredAmount,
        paymentType,
        screenshotFileId: screenshotFileId || '',
        screenshotPreviewUrl: screenshotPreviewUrl || '',
        status: 'en_attente_validation',
        createdAt: FieldValue.serverTimestamp(),
      });

      const prevHistory = Array.isArray(orderData.statusHistory) ? orderData.statusHistory : [];
      const nextHistory = [
        ...prevHistory,
        {
          status: orderData.status || 'recue',
          label: 'Paiement déclaré',
          actor: String(orderData.customerName),
          note: `${methodName} · ${declaredAmount} FCFA`,
          timestamp: nowIso,
        },
      ];
      const prevPaymentIds = Array.isArray(orderData.paymentIds)
        ? (orderData.paymentIds as string[])
        : [];
      const nextPaymentIds = [...prevPaymentIds, paymentId].slice(-20);

      const latestPayment = {
        paymentId,
        methodName,
        depositPhone: depositPhone.trim(),
        transactionRef: (transactionRef || '').trim(),
        declaredAmount,
        paymentType,
        status: 'en_attente_validation',
        createdAt: nowIso,
      };

      await adminDb.collection('payments').doc(paymentId).set(paymentDoc);
      await orderRef.update(
        sanitizeServerFirestore({
          paymentStatus: 'en_attente_validation',
          paymentIds: nextPaymentIds,
          latestPayment,
          statusHistory: nextHistory,
          updatedAt: FieldValue.serverTimestamp(),
        })
      );

      const updatedOrderSnap = await orderRef.get();
      res.status(201).json({
        payment: serializeFirestoreValue({ ...paymentDoc, createdAt: nowIso }),
        order: serializeFirestoreValue(updatedOrderSnap.data()),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible d’enregistrer cette déclaration de paiement.');
    }
  });

  // Authenticated client re-uploads a corrected file on their own order
  app.post('/api/client/orders/:orderId/reupload', async (req, res) => {
    try {
      const caller = await resolveServerClientCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Connexion client requise.' });
        return;
      }

      const orderRef = adminDb.collection('orders').doc(req.params.orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        res.status(404).json({ error: 'Commande introuvable.' });
        return;
      }
      const orderData = orderSnap.data() as Record<string, unknown>;
      if (orderData.clientAccountId !== caller.accountId) {
        res.status(403).json({ error: 'Accès refusé à cette commande.' });
        return;
      }

      const { oldFileId, newFile } = (req.body || {}) as {
        oldFileId?: string;
        newFile?: Record<string, unknown>;
      };
      if (!oldFileId || !newFile || typeof newFile.fileId !== 'string') {
        res.status(400).json({ error: 'Nouveau fichier manquant.' });
        return;
      }

      if (uploadsIndex[newFile.fileId]) {
        const owner = uploadsIndex[newFile.fileId].ownerClientAccountId;
        if (owner && owner !== caller.accountId) {
          res.status(403).json({ error: 'Fichier invalide.' });
          return;
        }
        if (!owner) {
          uploadsIndex[newFile.fileId].ownerClientAccountId = caller.accountId;
          saveIndex(uploadsIndex);
        }
      }

      const nowIso = new Date().toISOString();
      const prevFiles = Array.isArray(orderData.files)
        ? (orderData.files as Array<Record<string, unknown>>)
        : [];
      const updatedFiles = prevFiles.map((f) =>
        f.fileId === oldFileId ? { ...f, replaced: true } : f
      );
      updatedFiles.push(newFile);

      const prevHistory = Array.isArray(orderData.statusHistory) ? orderData.statusHistory : [];
      const nextHistory = [
        ...prevHistory,
        {
          status: 'en_verification',
          label: 'En vérification',
          actor: String(orderData.customerName),
          note: `Nouveau fichier renvoyé : ${String(newFile.originalName || '')} (v${String(newFile.version || 2)})`,
          timestamp: nowIso,
        },
      ];

      await orderRef.update(
        sanitizeServerFirestore({
          files: updatedFiles,
          status: 'en_verification',
          statusHistory: nextHistory,
          updatedAt: FieldValue.serverTimestamp(),
        })
      );

      const updatedSnap = await orderRef.get();
      res.json({ order: serializeFirestoreValue(updatedSnap.data()) });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de transmettre le fichier corrigé.');
    }
  });

  // Staff / Admin: list registered client accounts + order counts (never exposes hashes/salts)
  app.get('/api/admin/client-accounts', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentification atelier requise.' });
        return;
      }

      const [accountsSnap, ordersSnap] = await Promise.all([
        adminDb.collection('client_accounts').get(),
        adminDb.collection('orders').get(),
      ]);

      const countsByAccount = new Map<string, number>();
      for (const d of ordersSnap.docs) {
        const cid = (d.data() as { clientAccountId?: string }).clientAccountId;
        if (cid) {
          countsByAccount.set(cid, (countsByAccount.get(cid) || 0) + 1);
        }
      }

      const accounts = accountsSnap.docs
        .map((d) => {
          const data = d.data() as ClientAccountDoc;
          return {
            ...toPublicClientAccount(data),
            ordersCount: countsByAccount.get(data.accountId) || 0,
          };
        })
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      res.json({ accounts });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de charger les comptes clients.');
    }
  });

  // Admin-only: reset a client account password (sets temporary password + mustChangePassword)
  app.post('/api/admin/client-accounts/:accountId/reset-password', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }

      const { accountId } = req.params;
      const { newPassword } = (req.body || {}) as { newPassword?: string };
      const tempPassword =
        typeof newPassword === 'string' && newPassword.trim().length >= 6
          ? newPassword.trim()
          : `FBC-${randomAlphaNum(6)}`;

      if (tempPassword.length > 128) {
        res.status(400).json({ error: 'Mot de passe trop long.' });
        return;
      }

      const docRef = adminDb.collection('client_accounts').doc(accountId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Compte client introuvable.' });
        return;
      }
      const account = snap.data() as ClientAccountDoc;
      const { salt, hash } = hashStaffPassword(tempPassword);
      const nowIso = new Date().toISOString();

      await docRef.update({
        passwordHash: hash,
        passwordSalt: salt,
        mustChangePassword: true,
        updatedAt: nowIso,
      });

      await writeServerAuditLog({
        action: 'Réinitialisation mot de passe client',
        targetType: 'client_account',
        targetId: accountId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `@${account.username} (${account.phone})`,
      });

      res.json({
        ok: true,
        temporaryPassword: tempPassword,
        account: toPublicClientAccount({ ...account, mustChangePassword: true }),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de réinitialiser le mot de passe client.');
    }
  });

  // Admin-only: activate or deactivate a client account
  app.patch('/api/admin/client-accounts/:accountId', async (req, res) => {
    try {
      const caller = await resolveServerStaffCaller(req);
      if (!caller || caller.actorRole !== 'admin') {
        res.status(403).json({ error: 'Accès réservé à l’administrateur principal.' });
        return;
      }
      const { accountId } = req.params;
      const { active } = (req.body || {}) as { active?: boolean };
      if (typeof active !== 'boolean') {
        res.status(400).json({ error: 'Statut actif invalide.' });
        return;
      }
      const docRef = adminDb.collection('client_accounts').doc(accountId);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Compte client introuvable.' });
        return;
      }
      const account = snap.data() as ClientAccountDoc;
      await docRef.update({ active, updatedAt: new Date().toISOString() });

      await writeServerAuditLog({
        action: active ? 'Réactivation compte client' : 'Désactivation compte client',
        targetType: 'client_account',
        targetId: accountId,
        actorEmail: caller.actorEmail,
        actorRole: 'admin',
        details: `@${account.username} (${account.phone})`,
      });

      res.json({
        ok: true,
        account: toPublicClientAccount({ ...account, active }),
      });
    } catch (err) {
      handleServerApiError(res, err, 'Impossible de modifier ce compte client.');
    }
  });

  // Legacy unauthenticated lookup endpoint disabled: require client account login
  app.post('/api/orders/lookup', (_req, res) => {
    res.status(401).json({
      requiresAuth: true,
      error: 'Par sécurité, veuillez vous connecter à votre compte client (téléphone ou nom d’utilisateur et mot de passe) pour consulter vos commandes.',
    });
  });

  // Block direct access to internal server-views and legacy admin paths
  app.use('/server-views', (_req, res) => {
    res.status(404).send('Not Found');
  });
  app.get('/admin.html', (_req, res) => {
    res.status(404).send('Not Found');
  });

  const httpServer = http.createServer(app);

  const withQuery = (req: express.Request, targetPath: string) => {
    const qIdx = req.originalUrl.indexOf('?');
    return qIdx >= 0 ? `${targetPath}${req.originalUrl.slice(qIdx)}` : targetPath;
  };

  app.get('/', (req, res) => {
    res.redirect(302, withQuery(req, '/client/'));
  });
  app.get('/client', (req, res, next) => {
    if (req.path === '/client') {
      res.redirect(302, withQuery(req, '/client/'));
      return;
    }
    next();
  });
  app.get('/fbcprintgestionadmin', (req, res, next) => {
    if (req.path === '/fbcprintgestionadmin') {
      res.redirect(302, withQuery(req, '/fbcprintgestionadmin/'));
      return;
    }
    next();
  });

  // Mount Vite middleware in dev, or serve static dist in production
  if (process.env.NODE_ENV !== 'production') {
    app.get('/fbcprintgestionadmin/sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.resolve(process.cwd(), 'public/fbcprintgestionadmin/sw.js'));
    });

    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });

    app.get(/^\/fbcprintgestionadmin\/.*$/i, async (req, res, next) => {
      try {
        const adminHtmlPath = path.resolve(process.cwd(), 'server-views/atelier.html');
        const template = fs.readFileSync(adminHtmlPath, 'utf-8');
        let html = await vite.transformIndexHtml(req.originalUrl, template);
        html = html.replace(
          /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/gi,
          ''
        );
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

    app.get('/fbcprintgestionadmin/sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'fbcprintgestionadmin/sw.js'));
    });

    app.get(/^\/fbcprintgestionadmin\/.*$/i, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(distDir, 'server-views/atelier.html'));
    });

    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          }
        },
      })
    );
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

  httpServer.listen(PORT, '0.0.0.0', () => {
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
