// Local-only login helper: opens a real (headful) browser, you log into FPL
// normally yourself, and once that's done it reads the resulting refresh
// token straight out of the page's localStorage and pushes it to the
// running app via POST /auth/token. Nothing about the login itself is
// scripted — a real human (you) does the actual interaction, so the
// DataDome bot-guard on FPL's login flow has no reason to care. See
// project memory: fpl-write-api-contract, and CLAUDE.md's "Execution auth".
//
// Run with `pnpm run auth:login`. Reads AUTH_TARGET_URL (default
// http://localhost:3000) and AUTH_PUSH_SECRET from .env — the latter must
// match the running app's own AUTH_PUSH_SECRET, or the push is rejected.
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import axios, { isAxiosError } from 'axios';

const OIDC_STORAGE_KEY =
  'oidc.user:https://account.premierleague.com/as:bfcbaf69-aade-4c1b-8f00-c1cb8a193030';
const LOGIN_URL = 'https://fantasy.premierleague.com/';
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

// Error bodies from our own API are small and safe to log; anything from
// axios's request/response objects is not (could echo back the pushed
// secret in a header) — never log a raw AxiosError.
function describeError(error: unknown): string {
  if (isAxiosError(error)) {
    return JSON.stringify(error.response?.data ?? error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

function readEnvVar(name: string, fallback?: string): string {
  const envPath = path.resolve(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'));
  const value = match?.[1]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is not set in .env`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const targetUrl = readEnvVar('AUTH_TARGET_URL', 'http://localhost:3000');
  const pushSecret = readEnvVar('AUTH_PUSH_SECRET');

  console.log('[auth-login] opening a browser — log into FPL normally...');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(LOGIN_URL);

  console.log(
    '[auth-login] waiting for login to complete (up to 5 minutes)...',
  );
  const deadline = Date.now() + TIMEOUT_MS;
  let refreshToken: string | undefined;

  while (Date.now() < deadline) {
    refreshToken = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return undefined;
      try {
        return (JSON.parse(raw) as { refresh_token?: string }).refresh_token;
      } catch {
        return undefined;
      }
    }, OIDC_STORAGE_KEY);

    if (refreshToken) break;
    await sleep(POLL_INTERVAL_MS);
  }

  await browser.close();

  if (!refreshToken) {
    console.error('[auth-login] timed out waiting for login — try again.');
    process.exit(1);
  }

  console.log('[auth-login] login detected, pushing token to the app...');
  try {
    await axios.post(
      `${targetUrl}/auth/token`,
      { refreshToken },
      { headers: { Authorization: `Bearer ${pushSecret}` } },
    );
    console.log('[auth-login] done — the app should confirm over Telegram.');
  } catch (error) {
    console.error(
      `[auth-login] failed to push the token: ${describeError(error)}`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`[auth-login] failed: ${describeError(error)}`);
  process.exit(1);
});
