// Local dev convenience: starts the app + a Cloudflare quick tunnel, points
// the Telegram bot's webhook at the tunnel once it's up, and clears the
// webhook + kills both processes on Ctrl+C. Telegram can't reach localhost
// directly, so this is only needed to test the webhook-*receiving* side
// (tapping Approve/Reject) — see project memory: telegram-integration-live.
//
// ngrok is blocked by Windows Smart App Control on this machine and
// Microsoft devtunnel's relay doesn't connect — cloudflared is the one that
// works. Override its path with CLOUDFLARED_PATH if it's not on your PATH
// and not at the winget default below.
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import axios, { isAxiosError } from 'axios';

const CLOUDFLARED_CANDIDATES = [
  process.env.CLOUDFLARED_PATH,
  'cloudflared', // relies on PATH
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', // winget default
].filter((candidate): candidate is string => Boolean(candidate));

const APP_PORT = process.env.PORT ?? '3000';
const TUNNEL_URL_PATTERN = /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/;

// Telegram error bodies are small and safe to log; the request/response
// objects axios attaches are not — they carry the bot token in the URL, so
// never log a raw AxiosError (or any raw Error from this file) directly.
function describeError(error: unknown): string {
  if (isAxiosError(error)) {
    return JSON.stringify(error.response?.data ?? error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

// child.kill() only signals the immediate process — for `app` that's the
// `pnpm` shell wrapper (spawned with shell: true). Even `taskkill /T` (kill
// the whole tree) doesn't reliably reach the actual app process: confirmed
// live that `nest start --watch`'s internal restart-on-change management
// detaches the real app process from the tree it's tracking, so tree-kill
// can't see it and port 3000 stays held. What actually works (used manually
// all session): ask Windows who's listening on the port and kill that PID
// directly, regardless of process ancestry.
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    child.kill();
  }
}

function freePort(port: string): void {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
  ]);
}

function readEnvVar(name: string): string {
  const envPath = path.resolve(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!match) {
    throw new Error(`${name} is not set in .env`);
  }
  return match[1].trim();
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function setWebhook(botToken: string, url: string): Promise<void> {
  // Send `url` raw, not percent-encoded — confirmed live: axios's `params`
  // option encodes '/' but leaves ':' alone (a mangled hybrid Telegram
  // rejects), and a *fully* correct encodeURIComponent encoding also gets
  // rejected (apparently Telegram's API doesn't decode it back), while a
  // fully raw value — exactly what a manual `curl ".../setWebhook?url=https://..."`
  // sends — works.
  //
  // The retry here is only for genuine transient blips — confirmed live
  // that a tunnel instance which fails once typically never recovers no
  // matter how long you wait (9 attempts over 70s+ all failed identically,
  // while a *fresh* tunnel often works on the very first try). That's
  // handled one level up in main(): discard the tunnel and get a new
  // hostname rather than hammering a dead one.
  const maxAttempts = 3;
  const target = `https://api.telegram.org/bot${botToken}/setWebhook?url=${url}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await axios.get(target);
      console.log(`[dev-webhook] setWebhook -> ${url}:`, data);
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.log(
        `[dev-webhook] setWebhook attempt ${attempt} failed (${describeError(error)}), retrying...`,
      );
      await sleep(2000 * attempt);
    }
  }
}

async function deleteWebhook(botToken: string): Promise<void> {
  try {
    await axios.get(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
    console.log('[dev-webhook] webhook cleared');
  } catch (error) {
    console.warn(
      '[dev-webhook] failed to clear webhook:',
      describeError(error),
    );
  }
}

// Tries each candidate path in turn (PATH lookup, then the known winget
// install location) until one actually spawns, rather than failing outright
// the moment the first guess isn't found.
function startTunnel(
  onFailed: () => void,
  onReady: (child: ChildProcess) => void,
): void {
  const tryCandidate = (index: number): void => {
    if (index >= CLOUDFLARED_CANDIDATES.length) {
      console.error(
        '[dev-webhook] could not find cloudflared. Tried:',
        CLOUDFLARED_CANDIDATES,
        '\nSet CLOUDFLARED_PATH to its exe location and try again.',
      );
      onFailed();
      return;
    }

    const candidate = CLOUDFLARED_CANDIDATES[index];
    const child = spawn(candidate, [
      'tunnel',
      '--url',
      `http://localhost:${APP_PORT}`,
    ]);

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        tryCandidate(index + 1);
      } else {
        console.error(
          '[dev-webhook] cloudflared failed to start:',
          describeError(error),
        );
        process.exit(1);
      }
    });

    // Only commit to this candidate once it's actually running — 'spawn'
    // fires on success, 'error' (above) fires instead on failure.
    child.once('spawn', () => onReady(child));
  };

  tryCandidate(0);
}

const MAX_TUNNEL_ATTEMPTS = 4;

async function main(): Promise<void> {
  const botToken = readEnvVar('TELEGRAM_BOT_TOKEN');

  console.log('[dev-webhook] starting app (pnpm run start:dev)...');
  const app = spawn('pnpm', ['run', 'start:dev'], { shell: true });
  app.stdout.pipe(process.stdout);
  app.stderr.pipe(process.stderr);
  app.once('error', (error) => {
    console.error('[dev-webhook] app failed to start:', describeError(error));
    process.exit(1);
  });

  let cleaningUp = false;
  let currentTunnel: ChildProcess | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log('\n[dev-webhook] shutting down...');
    await deleteWebhook(botToken);
    if (currentTunnel) killTree(currentTunnel);
    killTree(app);
    freePort(APP_PORT);
    process.exit(0);
  };
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());

  const giveUp = (): void => {
    console.error(
      `[dev-webhook] giving up after ${MAX_TUNNEL_ATTEMPTS} tunnel attempts — try again, or run cloudflared manually to see if the network is degraded generally.`,
    );
    if (currentTunnel) killTree(currentTunnel);
    killTree(app);
    freePort(APP_PORT);
    process.exit(1);
  };

  // A tunnel instance that fails once typically never recovers, no matter
  // how long you retry the same hostname — confirmed live (9 retries over
  // 70s+, all identical failures), while a *fresh* tunnel often works on
  // the first try. So: discard and get a new hostname rather than hammering
  // a dead one.
  const attemptTunnel = (attempt: number): void => {
    console.log(
      `[dev-webhook] starting cloudflared tunnel (attempt ${attempt}/${MAX_TUNNEL_ATTEMPTS})...`,
    );
    startTunnel(
      () => {
        killTree(app);
        freePort(APP_PORT);
        process.exit(1);
      },
      (tunnel) => {
        currentTunnel = tunnel;
        let resolved = false;
        let tunnelUrl: string | undefined;
        const onTunnelOutput = (chunk: Buffer): void => {
          const text = chunk.toString();
          process.stdout.write(`[tunnel] ${text}`);
          if (resolved) return;

          if (!tunnelUrl) {
            const match = TUNNEL_URL_PATTERN.exec(text);
            if (match) tunnelUrl = match[0];
          }
          // Cloudflared prints the URL before the tunnel is actually
          // routable from Cloudflare's edge — confirmed live: setWebhook
          // right on the URL line gets "Failed to resolve host" from
          // Telegram even though DNS itself resolves instantly (it's a
          // shared *.trycloudflare.com edge IP; routing to *this* tunnel
          // isn't live until registration completes). Wait for that
          // explicit line too.
          if (!tunnelUrl || !text.includes('Registered tunnel connection')) {
            return;
          }

          resolved = true;
          setWebhook(botToken, `${tunnelUrl}/approval/telegram-callback`).catch(
            (error: unknown) => {
              console.error(
                `[dev-webhook] tunnel attempt ${attempt} failed:`,
                describeError(error),
              );
              killTree(tunnel);
              if (attempt >= MAX_TUNNEL_ATTEMPTS) {
                giveUp();
              } else {
                attemptTunnel(attempt + 1);
              }
            },
          );
        };
        // cloudflared logs to stderr by default.
        tunnel.stdout?.on('data', onTunnelOutput);
        tunnel.stderr?.on('data', onTunnelOutput);
      },
    );
  };

  attemptTunnel(1);
}

main().catch((error: unknown) => {
  console.error('[dev-webhook] failed:', describeError(error));
  process.exit(1);
});
