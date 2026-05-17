/**
 * dacc — DAC Inception auto farmer (multi-wallet)
 *
 * Baca wallets.txt (satu address per baris)
 * Tiap wallet jalan paralel, masing-masing punya session sendiri
 *
 * Loop per wallet:
 * 1. Login (relogin otomatis kalau session expired)
 * 2. Faucet claim — cooldown dari server (seconds_left)
 * 3. Crate open x5 — auto sleep sampai midnight UTC kalau limit
 */

require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { login, getProfile, claimFaucet, openCrate } = require('./api');

// ─── Load wallets ─────────────────────────────────────────────────────────────

const WALLETS_FILE = path.join(__dirname, '..', 'wallets.txt');

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) {
    console.error(chalk.red('❌ wallets.txt tidak ditemukan'));
    process.exit(1);
  }
  const wallets = fs.readFileSync(WALLETS_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('0x') && l.length >= 40);

  if (!wallets.length) {
    console.error(chalk.red('❌ wallets.txt kosong'));
    process.exit(1);
  }
  return wallets;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function shortAddr(addr) {
  return addr.slice(0, 8) + '...' + addr.slice(-4);
}

function log(color, wallet, tag, msg) {
  console.log(
    chalk[color](`[${ts()}]`),
    chalk.gray(`[${shortAddr(wallet)}]`),
    chalk[color](`[${tag}]`),
    msg
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function msUntilMidnightUTC() {
  const now  = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 10
  ));
  return next.getTime() - now.getTime();
}

function fmtDuration(ms) {
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}j ${m}m ${sec}s`;
}

function needsRelogin(status) {
  return status === 401 || status === 403;
}

// ─── Per-wallet runner ────────────────────────────────────────────────────────

async function runWallet(wallet) {
  let csrf      = null;
  let sessionid = null;

  // Login dengan retry
  async function ensureLogin() {
    let retries = 0;
    while (true) {
      try {
        const { csrf: c, sessionid: s, user } = await login(wallet);
        csrf      = c;
        sessionid = s;
        log('green', wallet, 'LOGIN', `OK | QE: ${user?.qe_balance ?? '?'}`);
        return;
      } catch (e) {
        retries++;
        log('red', wallet, 'LOGIN', `Gagal (${retries}): ${e.message}`);
        await sleep(15000);
      }
    }
  }

  // Faucet loop
  async function runFaucet() {
    while (true) {
      try {
        const { status, body } = await claimFaucet(csrf, sessionid);

        if (needsRelogin(status)) {
          log('yellow', wallet, 'FAUCET', 'Session expired → relogin...');
          await ensureLogin();
          continue;
        }

        if (body.seconds_left > 0) {
          const wait = body.seconds_left * 1000;
          log('gray', wallet, 'FAUCET', `Cooldown ${fmtDuration(wait)}`);
          await sleep(wait + 2000);
          continue;
        }

        if (body.error) {
          // social_required = belum link X/Discord, tunggu 1 jam
          if (body.code === 'social_required') {
            log('yellow', wallet, 'FAUCET', `Social belum linked — skip 1 jam`);
            await sleep(3600 * 1000);
          } else {
            log('red', wallet, 'FAUCET', `Error: ${body.error}`);
            await sleep(60 * 1000);
          }
          continue;
        }

        if (body.success) {
          log('green', wallet, 'FAUCET', `✔ Claimed!`);
          await sleep(3000);
          try {
            const profile = await getProfile(csrf, sessionid);
            const wait    = (profile.faucet_seconds_left ?? 28800) * 1000;
            log('gray', wallet, 'FAUCET', `Next dalam ${fmtDuration(wait)}`);
            await sleep(wait + 2000);
          } catch {
            await sleep(8 * 3600 * 1000);
          }
          continue;
        }

        log('yellow', wallet, 'FAUCET', `Unknown: ${JSON.stringify(body).slice(0, 150)}`);
        await sleep(60 * 1000);

      } catch (e) {
        log('red', wallet, 'FAUCET', `Exception: ${e.message}`);
        await sleep(30 * 1000);
      }
    }
  }

  // Crate loop
  async function runCrate() {
    while (true) {
      try {
        const { status, body } = await openCrate(csrf, sessionid);

        if (needsRelogin(status)) {
          log('yellow', wallet, 'CRATE', 'Session expired → relogin...');
          await ensureLogin();
          continue;
        }

        if (body.error) {
          const err = body.error.toLowerCase();
          if (err.includes('limit') || err.includes('daily')) {
            const wait = msUntilMidnightUTC();
            log('gray', wallet, 'CRATE', `Daily limit — tunggu midnight UTC (${fmtDuration(wait)})`);
            await sleep(wait);
          } else if (err.includes('insufficient')) {
            log('yellow', wallet, 'CRATE', `QE kurang: ${body.error} — cek 30 menit`);
            await sleep(30 * 60 * 1000);
          } else {
            log('red', wallet, 'CRATE', `Error: ${body.error}`);
            await sleep(60 * 1000);
          }
          continue;
        }

        if (body.success) {
          const reward     = body.reward?.label ?? '?';
          const opensToday = body.opens_today ?? '?';
          const limit      = body.daily_open_limit ?? 5;
          const qe         = body.new_total_qe ?? '?';
          log('cyan', wallet, 'CRATE', `✔ ${reward} | ${opensToday}/${limit} | QE: ${qe}`);

          if (opensToday >= limit) {
            const wait = msUntilMidnightUTC();
            log('gray', wallet, 'CRATE', `Limit — tunggu midnight UTC (${fmtDuration(wait)})`);
            await sleep(wait);
          } else {
            await sleep(3000);
          }
          continue;
        }

        log('yellow', wallet, 'CRATE', `Unknown: ${JSON.stringify(body).slice(0, 150)}`);
        await sleep(60 * 1000);

      } catch (e) {
        log('red', wallet, 'CRATE', `Exception: ${e.message}`);
        await sleep(30 * 1000);
      }
    }
  }

  // Init wallet
  await ensureLogin();

  try {
    const p = await getProfile(csrf, sessionid);
    log('gray', wallet, 'INFO', `QE: ${p.qe_balance} | Streak: ${p.streak_days}d | Faucet: ${p.faucet_available ? 'ready' : fmtDuration(p.faucet_seconds_left * 1000)}`);
  } catch {}

  // Faucet + crate paralel per wallet
  await Promise.all([runFaucet(), runCrate()]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const wallets = loadWallets();

  console.log(chalk.cyan(`
  ╔══════════════════════════════════════════════════════╗
  ║       DAC Inception — Auto Farmer                   ║
  ╚══════════════════════════════════════════════════════╝`));
  console.log(chalk.gray(`  Wallets : ${wallets.length}`));
  console.log(chalk.gray(`  Tasks   : faucet + crate (24/7)\n`));

  wallets.forEach(w => console.log(chalk.gray(`  · ${w}`)));
  console.log();

  // Semua wallet jalan paralel
  await Promise.all(wallets.map(w => runWallet(w)));
}

main().catch(err => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});
