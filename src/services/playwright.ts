/*
 * playwright.ts — sessão Qwen via login API direto + cookie
 * Suporte a múltiplas sessões isoladas por sessionId.
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let sessionCookie = '';
let sessionUserAgent = '';
let currentAccountIndex = 0;
let windowsProfileSecured = false;

// Multi-account support
interface QwenAccount { email: string; password: string; }
let accounts: QwenAccount[] = [];
let activeAccount: QwenAccount | null = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const QWEN_SETUP_TIMEOUT_MS = 30000;
function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal?.reason || new DOMException('The operation was aborted.', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
const accountLabel = (index: number) => `account-${index + 1}`;
const SESSION_FILE = path.resolve('qwen_profile', 'session.json');
const QWEN_COOKIE_URLS = ['https://chat.qwen.ai', 'https://qwen.ai'];
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_SESSIONS = 256;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function secureWindowsPath(target: string, recursive = false): boolean {
  if (process.platform !== 'win32') return true;
  const username = process.env.USERNAME;
  if (!username || !/^[A-Za-z0-9._-]+$/.test(username)) return false;
  const domain = process.env.USERDOMAIN;
  const principal = domain && /^[A-Za-z0-9._-]+$/.test(domain) ? `${domain}\\${username}` : username;
  try {
    const scopeArgs = recursive ? ['/T', '/C'] : [];
    execFileSync('icacls', [target, '/reset', ...scopeArgs], { stdio: 'ignore', windowsHide: true, timeout: QWEN_SETUP_TIMEOUT_MS });
    execFileSync('icacls', [target, '/inheritance:r', ...scopeArgs], { stdio: 'ignore', windowsHide: true, timeout: QWEN_SETUP_TIMEOUT_MS });
    execFileSync('icacls', [target, '/grant:r', `${principal}:${recursive ? '(OI)(CI)F' : 'F'}`, `SYSTEM:${recursive ? '(OI)(CI)F' : 'F'}`, ...scopeArgs], { stdio: 'ignore', windowsHide: true, timeout: QWEN_SETUP_TIMEOUT_MS });
    const acl = execFileSync('icacls', [target, '/Q'], { encoding: 'utf8', windowsHide: true, timeout: QWEN_SETUP_TIMEOUT_MS });
    const entries = acl.split(String.fromCharCode(10)).slice(1).map(line => line.trim()).filter(Boolean);
    const allowedPrincipals = new Set([principal.toLowerCase(), username.toLowerCase(), 'system', 'nt authority\\system']);
    if (entries.length < 2) return false;
    for (const entry of entries) {
      const separator = entry.indexOf(':');
      if (separator <= 0 || !allowedPrincipals.has(entry.slice(0, separator).trim().toLowerCase())) return false;
    }
    return entries.some(entry => {
      const separator = entry.indexOf(':');
      return separator > 0 && entry.slice(0, separator).trim().toLowerCase() === principal.toLowerCase();
    });
  } catch {
    return false;
  }
}

function hasPrivateSessionFilePermissions(): boolean {
  // Node's POSIX mode bits do not enforce ACLs on Windows. Without a
  // verified NTFS ACL check, never treat the persisted cookie as private.
  if (process.platform === 'win32') return fs.existsSync(SESSION_FILE) && secureWindowsPath(SESSION_FILE);
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
    const mode = fs.statSync(SESSION_FILE).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return false;
  }
}

// ─── Session store: sessionId → { chatId, parentId } ──────────────

interface SessionState {
  chatId: string | null;
  parentId: string | null;
  createdAt: number;
  lastUsed: number;
}

const sessions = new Map<string, SessionState>();
const DEFAULT_SESSION = 'main';

function pruneSessions(now = Date.now()): void {
  for (const [id, state] of sessions) {
    if (id !== DEFAULT_SESSION && now - state.lastUsed > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getSession(sessionId?: string): SessionState {
  const id = sessionId || DEFAULT_SESSION;
  const now = Date.now();
  pruneSessions(now);
  if (!sessions.has(id)) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()]
        .filter(([candidate]) => candidate !== DEFAULT_SESSION)
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    sessions.set(id, { chatId: null, parentId: null, createdAt: now, lastUsed: now });
  }
  const s = sessions.get(id)!;
  s.lastUsed = now;
  return s;
}

// ─── Mutex ──────────────────────────────────────────────────────────

interface MutexWaiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Mutex {
  private queue: MutexWaiter[] = [];
  private locked = false;
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');
    if (!this.locked) { this.locked = true; return this.makeRelease(); }
    return new Promise((resolve, reject) => {
      const waiter: MutexWaiter = { resolve, reject, signal };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason || new DOMException('The operation was aborted.', 'AbortError'));
      };
      waiter.onAbort = onAbort;
      this.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  get isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        next.signal.removeEventListener('abort', next.onAbort!);
        next.reject(next.signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
        continue;
      }
      next.signal?.removeEventListener('abort', next.onAbort!);
      next.resolve(this.makeRelease());
      return;
    }
    this.locked = false;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }
}

const accountStateMutex = new Mutex();

export function acquireAccountStateLock(signal?: AbortSignal): Promise<() => void> {
  return accountStateMutex.acquire(signal);
}

// ─── Cookie helpers ─────────────────────────────────────────────────

async function readQwenCookies(): Promise<string> {
  if (!activePage) return sessionCookie;
  const cookies = await activePage.context().cookies(QWEN_COOKIE_URLS);
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export async function getCookies(): Promise<string> {
  if (!sessionCookie && activePage) {
    sessionCookie = await readQwenCookies();
  }
  return sessionCookie;
}

export async function getUserAgent(): Promise<string> {
  if (!sessionUserAgent && activePage) {
    sessionUserAgent = await activePage.evaluate(() => navigator.userAgent);
  }
  return sessionUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
}

function saveLoginState() {
  const temporaryFile = `${SESSION_FILE}.tmp-${process.pid}`;
  try {
    const sessionDirectory = path.dirname(SESSION_FILE);
    fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(sessionDirectory, 0o700);
    if (process.platform === 'win32' && !windowsProfileSecured) {
      if (!secureWindowsPath(sessionDirectory, true)) return;
      windowsProfileSecured = true;
    }
    const sessionList: Record<string, SessionState> = {};
    for (const [k, v] of sessions) sessionList[k] = v;
    fs.writeFileSync(temporaryFile, JSON.stringify({ userAgent: sessionUserAgent, sessions: sessionList, savedAt: Date.now() }), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(temporaryFile, 0o600);
    if (process.platform === 'win32' && !secureWindowsPath(temporaryFile)) {
      try { fs.rmSync(temporaryFile, { force: true }); } catch {}
      return;
    }
    if (process.platform === 'win32') {
      try { fs.rmSync(SESSION_FILE, { force: true }); } catch {}
    }
    fs.renameSync(temporaryFile, SESSION_FILE);
    if (!hasPrivateSessionFilePermissions()) {
      try { fs.rmSync(SESSION_FILE, { force: true }); } catch {}
    }
  } catch {
    try { fs.rmSync(temporaryFile, { force: true }); } catch {}
  }
}

function loadLoginState(): boolean {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      if (!hasPrivateSessionFilePermissions()) {
        try { fs.rmSync(SESSION_FILE, { force: true }); } catch {}
        return false;
      }
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (Date.now() - data.savedAt < 24 * 60 * 60 * 1000) {
        const hadLegacyCookie = typeof data.cookie === 'string';
        sessionCookie = '';
        sessionUserAgent = data.userAgent || '';
        if (data.sessions && typeof data.sessions === 'object') {
          for (const [k, v] of Object.entries(data.sessions)) {
            const state = v as Partial<SessionState>;
            if (!SESSION_ID_PATTERN.test(k) || typeof state.lastUsed !== 'number' || Date.now() - state.lastUsed > SESSION_TTL_MS) continue;
            sessions.set(k, {
              chatId: typeof state.chatId === 'string' ? state.chatId : null,
              parentId: typeof state.parentId === 'string' ? state.parentId : null,
              createdAt: typeof state.createdAt === 'number' ? state.createdAt : state.lastUsed,
              lastUsed: state.lastUsed,
            });
            if (sessions.size >= MAX_SESSIONS) break;
          }
        }
        if (hadLegacyCookie) saveLoginState();
        return false;
      }
    }
  } catch {}
  return false;
}

// ─── Init / Login ───────────────────────────────────────────────────

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  // Testes unitários nunca devem abrir uma janela ou iniciar um processo
  // Chromium. O modo mock usa o fallback HTTP do serviço Qwen e mantém os
  // testes determinísticos, mesmo quando rodam em paralelo.
  if (process.env.TEST_MOCK_PLAYWRIGHT === 'true') {
    sessionCookie = '';
    sessionUserAgent = 'Mozilla/5.0 (test)';
    getSession(DEFAULT_SESSION);
    return;
  }
  if (context) return;

  const profilePath = path.resolve('qwen_profile');
  fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(profilePath, 0o700);
  if (process.platform === 'win32' && !secureWindowsPath(profilePath, true)) {
    throw new Error('Qwen persistent profile ACL could not be restricted on Windows');
  }
  windowsProfileSecured = process.platform === 'win32';
  let browserEngine: any;
  let channel: string | undefined;

  switch (browserType) {
    case 'firefox': browserEngine = firefox; break;
    case 'webkit': browserEngine = webkit; break;
    case 'chrome': browserEngine = chromium; channel = 'chrome'; break;
    case 'edge': browserEngine = chromium; channel = 'msedge'; break;
    default: browserEngine = chromium;
  }

  console.log(`[Session] Launching ${browserType}...`);
  context = await browserEngine.launchPersistentContext(profilePath, {
    headless, channel,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  await context!.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  activePage = await context!.newPage();
  accounts = loadConfiguredAccounts();

  loadLoginState();

  if (!(await checkValidSession())) {
    await attemptAutoLogin();
  }

  // Ensure default session exists
  getSession(DEFAULT_SESSION);
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(3000);
    const isLoggedIn = await activePage.evaluate(() => {
      const hasChatInput = !!document.querySelector('textarea, [contenteditable="true"]');
      const buttons = document.querySelectorAll('button, a');
      let hasLoginBtn = false;
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('sign up') || text.includes('entrar') || text.includes('inscrever')) {
          hasLoginBtn = true; break;
        }
      }
      return hasChatInput && !hasLoginBtn;
    });
    if (isLoggedIn) {
      sessionCookie = await readQwenCookies();
      sessionUserAgent = await activePage.evaluate(() => navigator.userAgent);
      saveLoginState();
    }
    return isLoggedIn;
  } catch { return false; }
}

function loadConfiguredAccounts(): QwenAccount[] {
  const configured: QwenAccount[] = [];
  if (process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD) {
    configured.push({ email: process.env.QWEN_EMAIL, password: process.env.QWEN_PASSWORD });
  }
  for (let i = 2; i <= 10; i++) {
    const email = process.env[`QWEN_EMAIL_${i}`];
    const password = process.env[`QWEN_PASSWORD_${i}`];
    if (email && password) configured.push({ email, password });
  }
  return configured;
}

async function attemptAutoLogin(): Promise<void> {
  accounts = loadConfiguredAccounts();
  if (accounts.length === 0) {
    console.warn('[Session] No credentials. Manual login needed.');
    return;
  }

  console.log(`[Session] ${accounts.length} account(s) configured.`);

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    console.log(`[Session] Trying login: ${accountLabel(i)}...`);
    const ok = await tryLogin(account.email, account.password);
    if (ok) {
      currentAccountIndex = i;
      activeAccount = account;
      return;
    }
    console.warn(`[Session] Login failed for ${accountLabel(i)}, trying next...`);
  }

  console.error('[Session] All accounts failed to login.');
}

async function tryLogin(email: string, password: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');
  const hp = crypto.createHash('sha256').update(password).digest('hex');
  await activePage!.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: QWEN_SETUP_TIMEOUT_MS });
  await waitWithAbort(2000, signal);
  const ok = await activePage!.evaluate(async (p: any) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const r = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'source': 'web', 'timezone': new Date().toString().split(' (')[0], 'x-request-id': window.crypto.randomUUID() },
        body: JSON.stringify({ email: p.email, password: p.password, login_type: 'email' }),
        signal: controller.signal,
      });
      return r.ok;
    } finally { clearTimeout(timer); }
  }, { email, password: hp, timeoutMs: QWEN_SETUP_TIMEOUT_MS });
  if (!ok) return false;
  await activePage!.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: QWEN_SETUP_TIMEOUT_MS });
  await waitWithAbort(3000, signal);
  sessionCookie = await readQwenCookies();
  sessionUserAgent = await activePage!.evaluate(() => navigator.userAgent);
  saveLoginState();
  console.log('[Session] Login successful.');
  return true;
}

// ─── Session API ────────────────────────────────────────────────────

export function getActiveChatId(sessionId?: string): string | null {
  return getSession(sessionId).chatId;
}

export function setActiveChatId(chatId: string | null, sessionId?: string) {
  const s = getSession(sessionId);
  s.chatId = chatId;
  if (chatId === null) s.parentId = null;
  saveLoginState();
}

export function getActiveParentId(sessionId?: string): string | null {
  return getSession(sessionId).parentId;
}

export function setActiveParentId(parentId: string | null, sessionId?: string) {
  getSession(sessionId).parentId = parentId;
  saveLoginState();
}

async function rotateAccountUnlocked(signal?: AbortSignal): Promise<boolean> {
  if (accounts.length <= 1) return false;
  currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
  const next = accounts[currentAccountIndex];
  console.log(`[Session] Rotating to ${accountLabel(currentAccountIndex)}`);
  // Re-login with the new account
  const ok = await tryLogin(next.email, next.password, signal);
  if (ok) {
    activeAccount = next;
    clearAllSessionChats();
    return true;
  }
  console.error(`[Session] Rotation failed for ${accountLabel(currentAccountIndex)}`);
  return false;
}

export async function rotateAccount(lockHeld = false, signal?: AbortSignal): Promise<boolean> {
  if (lockHeld) return rotateAccountUnlocked(signal);
  const release = await acquireAccountStateLock(signal);
  try {
    return await rotateAccountUnlocked(signal);
  } finally {
    release();
  }
}

export function invalidateSessionChat(sessionId?: string): void {
  const state = getSession(sessionId);
  state.chatId = null;
  state.parentId = null;
  state.lastUsed = Date.now();
  saveLoginState();
}

export function clearAllSessionChats(): void {
  for (const state of sessions.values()) {
    state.chatId = null;
    state.parentId = null;
    state.lastUsed = Date.now();
  }
  saveLoginState();
}

export function getActiveAccountEmail(): string | null {
  return activeAccount?.email || null;
}

export function listSessions(): Record<string, { chatId: string | null; createdAt: number; lastUsed: number }> {
  const result: Record<string, any> = {};
  for (const [id, s] of sessions) {
    result[id] = { chatId: s.chatId, createdAt: s.createdAt, lastUsed: s.lastUsed };
  }
  return result;
}

export function deleteSession(sessionId: string): boolean {
  if (sessionId === DEFAULT_SESSION) return false;
  const deleted = sessions.delete(sessionId);
  if (deleted) saveLoginState();
  return deleted;
}

export async function resetSession(sessionId?: string) {
  if (sessionId) {
    sessions.delete(sessionId);
  } else {
    sessions.clear();
  }
  saveLoginState();
}

export async function closePlaywright() {
  saveLoginState();
  if (context) { await context.close(); context = null; activePage = null; }
}
