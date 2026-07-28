/*
 * index.ts — QwenProxy server entry point
 * OpenAI-compatible API with multi-session support for agents + subagents.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions, sessionInfo, sessionList, sessionReset, sessionDelete, sessionFork } from './routes/chat.ts';
import { fetchQwenModels } from './services/qwen.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, closePlaywright, BrowserType } from './services/playwright.ts';
import { networkInterfaces } from 'os';

dotenv.config();
export const app = new Hono();
app.use('*', cors());

function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

// ── Routes ──────────────────────────────────────────────────────────

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/v1/models', async (c) => {
  try { const models = await fetchQwenModels(); return c.json({ object: 'list', data: models }); }
  catch (err: any) { return c.json({ error: { message: err.message } }, 500); }
});

app.post('/v1/chat/completions', chatCompletions);

// Session management (multi-agent support)
app.get('/v1/session', sessionInfo);
app.get('/v1/sessions', sessionList);
app.post('/v1/session/reset', sessionReset);
app.delete('/v1/session', sessionDelete);
app.post('/v1/session/fork', sessionFork);

// ── Startup ─────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find(a => a.startsWith('--browser='));
  if (browserArg) browserType = browserArg.split('=')[1] as BrowserType;
  else if (process.env.BROWSER) browserType = process.env.BROWSER as BrowserType;

  initPlaywright(process.env.HEADLESS !== 'false', browserType).then(() => {
    console.log(`[QwenProxy] Session ready (${browserType}).`);
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    const networkIP = getNetworkAddress();
    console.log('\n🚀 QwenProxy Agentic started!');
    console.log(`- Local:   http://localhost:${port}`);
    if (networkIP) console.log(`- Network: http://${networkIP}:${port}`);
    console.log('\nRoutes:');
    console.log('  [GET]    /health');
    console.log('  [GET]    /v1/models');
    console.log('  [POST]   /v1/chat/completions');
    console.log('  [GET]    /v1/session?id=<id>');
    console.log('  [GET]    /v1/sessions');
    console.log('  [POST]   /v1/session/reset?id=<id>');
    console.log('  [DELETE] /v1/session?id=<id>');
    console.log('  [POST]   /v1/session/fork');
    console.log('\nSession headers:');
    console.log('  X-Session-Id: <id>   → use specific session');
    console.log('  X-New-Session: true  → create fresh session\n');
    serve({ fetch: app.fetch, port });
  }).catch((err: any) => {
    console.error('[QwenProxy] Failed:', err.message);
    process.exit(1);
  });
}

process.on('SIGINT', async () => { console.log('\n[QwenProxy] Shutting down...'); await closePlaywright(); process.exit(0); });
process.on('SIGTERM', async () => { await closePlaywright(); process.exit(0); });
