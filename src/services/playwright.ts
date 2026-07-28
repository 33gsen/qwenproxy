/*
 * playwright.ts — sessão Qwen via login API direto + cookie
 * Suporte a múltiplas sessões isoladas por sessionId.
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let sessionCookie = '';
let sessionUserAgent = '';
let currentAccountIndex = 0;

// Multi-account support
interface QwenAccount { email: string; password: string; }
let accounts: QwenAccount[] = [];
let activeAccount: QwenAccount | null = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SESSION_FILE = path.resolve('qwen_profile', 'session.json');

// ─── Session store: sessionId → { chatId, parentId } ──────────────

interface SessionState {
  chatId: string | null;
  parentId: string | null;
  createdAt: number;
  lastUsed: number;
}

const sessions = new Map<string, SessionState>();
const DEFAULT_SESSION = 'main';

function getSession(sessionId?: string): SessionState {
  const id = sessionId || DEFAULT_SESSION;
  if (!sessions.has(id)) {
    sessions.set(id, { chatId: null, parentId: null, createdAt: Date.now(), lastUsed: Date.now() });
  }
  const s = sessions.get(id)!;
  s.lastUsed = Date.now();
  return s;
}

// ─── Mutex ──────────────────────────────────────────────────────────

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  async acquire(): Promise<() => void> {
    if (!this.locked) { this.locked = true; return () => this.release(); }
    return new Promise(r => { this.queue.push(() => { r(() => this.release()); }); });
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

// ─── Cookie helpers ─────────────────────────────────────────────────

export async function getCookies(): Promise<string> {
  if (!sessionCookie && activePage) {
    const cookies = await activePage.context().cookies();
    sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
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
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const sessionList: Record<string, SessionState> = {};
    for (const [k, v] of sessions) sessionList[k] = v;
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookie: sessionCookie, userAgent: sessionUserAgent, sessions: sessionList, savedAt: Date.now() }));
  } catch {}
}

function loadLoginState(): boolean {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (Date.now() - data.savedAt < 24 * 60 * 60 * 1000) {
        sessionCookie = data.cookie || '';
        sessionUserAgent = data.userAgent || '';
        if (data.sessions) {
          for (const [k, v] of Object.entries(data.sessions)) {
            sessions.set(k, v as SessionState);
          }
        }
        return !!sessionCookie;
      }
    }
  } catch {}
  return false;
}

// ─── Init / Login ───────────────────────────────────────────────────

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (context) return;

  const profilePath = path.resolve('qwen_profile');
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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  activePage = await context.newPage();

  if (loadLoginState()) {
    console.log('[Session] Loaded saved session from disk.');
    const pairs = sessionCookie.split('; ').filter(Boolean);
    const cookies = pairs.map(p => {
      const [name, ...rest] = p.split('=');
      return { name, value: rest.join('='), domain: '.qwen.ai', path: '/' };
    });
    await context.addCookies(cookies);
  }

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
      const cookies = await activePage.context().cookies();
      sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      sessionUserAgent = await activePage.evaluate(() => navigator.userAgent);
      saveLoginState();
    }
    return isLoggedIn;
  } catch { return false; }
}

async function attemptAutoLogin(): Promise<void> {
  // Collect all accounts from env
  accounts = [];
  if (process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD) {
    accounts.push({ email: process.env.QWEN_EMAIL, password: process.env.QWEN_PASSWORD });
  }
  for (let i = 2; i <= 10; i++) {
    const email = process.env[`QWEN_EMAIL_${i}`];
    const password = process.env[`QWEN_PASSWORD_${i}`];
    if (email && password) accounts.push({ email, password });
    else break;
  }

  if (accounts.length === 0) {
    console.warn('[Session] No credentials. Manual login needed.');
    return;
  }

  console.log(`[Session] ${accounts.length} account(s) configured.`);

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    console.log(`[Session] Trying login: ${account.email}...`);
    const ok = await tryLogin(account.email, account.password);
    if (ok) {
      currentAccountIndex = i;
      activeAccount = account;
      return;
    }
    console.warn(`[Session] Login failed for ${account.email}, trying next...`);
  }

  console.error('[Session] All accounts failed to login.');
}

async function tryLogin(email: string, password: string): Promise<boolean> {
  const hp = crypto.createHash('sha256').update(password).digest('hex');
  await activePage!.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const ok = await activePage!.evaluate(async (p: any) => {
    const r = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'source': 'web', 'timezone': new Date().toString().split(' (')[0], 'x-request-id': window.crypto.randomUUID() },
      body: JSON.stringify({ email: p.email, password: p.password, login_type: 'email' }),
    });
    return r.ok;
  }, { email, password: hp });
  if (!ok) return false;
  await activePage!.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const cookies = await activePage!.context().cookies();
  sessionCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  sessionUserAgent = await activePage!.evaluate(() => navigator.userAgent);
  saveLoginState();
  console.log(`[Session] Logged in as ${email}.`);
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

export function rotateAccount(): boolean {
  if (accounts.length <= 1) return false;
  currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
  const next = accounts[currentAccountIndex];
  console.log(`[Session] Rotating to account: ${next.email}`);
  // Clear session to force fresh login with new account
  sessionCookie = '';
  activeAccount = null;
  saveLoginState();
  return true;
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
  return sessions.delete(sessionId);
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
