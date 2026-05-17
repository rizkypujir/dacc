/**
 * cappuccino.js — Cappuccino v4 auto farmer
 *
 * Flow:
 * 1. Register (skip kalau sudah ada)
 * 2. Claim semua mission yang completed & belum claimed
 * 3. Buka vault prioritas: abyss (100xp) → deep (30xp) → surface (20xp)
 * 4. Loop tiap 1 jam
 *
 * wallets-cappuccino.txt format (satu per baris):
 *   username|walletAddress
 */

require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const chalk = require('chalk');

const WALLETS_FILE = path.join(__dirname, '..', 'wallets-cappuccino.txt');
const REFERRER     = 'kyycode';

// XP cost per vault type (dari hasil test)
const VAULT_PRIORITY = [
  { type: 'abyss',   cost: 100 },
  { type: 'deep',    cost: 30  },
  { type: 'surface', cost: 20  },
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'cappuccinov4.xyz', path, method,
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'origin':       'https://cappuccinov4.xyz',
        'referer':      'https://cappuccinov4.xyz/',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function log(color, user, tag, msg) {
  console.log(chalk[color](`[${ts()}]`), chalk.gray(`[${user}]`), chalk[color](`[${tag}]`), msg);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) {
    console.error(chalk.red(`❌ ${WALLETS_FILE} tidak ditemukan`));
    console.error(chalk.gray('  Format: username|0xWalletAddress (satu per baris)'));
    process.exit(1);
  }
  return fs.readFileSync(WALLETS_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('|'))
    .map(l => {
      const [username, walletAddress] = l.split('|').map(s => s.trim());
      return { username, walletAddress };
    })
    .filter(w => w.username && w.walletAddress?.startsWith('0x'));
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function getUser(walletAddress) {
  const r = await req('GET', `/api/users/by-wallet/${walletAddress}`, null);
  if (r.status === 200) return r.body;
  return null;
}

async function register(username, walletAddress) {
  const r = await req('POST', '/api/users/register', { username, walletAddress, referrer: REFERRER });
  return r;
}

async function getMissions(username) {
  const r = await req('GET', `/api/missions?username=${encodeURIComponent(username)}`, null);
  if (r.status === 200) return r.body;
  return [];
}

async function claimMission(username, missionId) {
  const r = await req('POST', `/api/missions/${missionId}/claim`, { username });
  return r;
}

async function openVault(username, walletAddress, vaultType) {
  const r = await req('POST', '/api/vaults/open', { username, walletAddress, vault: vaultType });
  return r;
}

// ─── Per-wallet runner ────────────────────────────────────────────────────────

async function runWallet({ username, walletAddress }) {
  const label = username;

  while (true) {
    try {
      // 1. Cek / register user
      let user = await getUser(walletAddress);
      if (!user) {
        log('yellow', label, 'REGISTER', `User belum ada, registering...`);
        const r = await register(username, walletAddress);
        if (r.status === 200) {
          user = r.body;
          log('green', label, 'REGISTER', `✔ Registered | points: ${user.points ?? 0}`);
        } else {
          log('red', label, 'REGISTER', `Gagal: ${JSON.stringify(r.body).slice(0, 150)}`);
          await sleep(60000);
          continue;
        }
      }

      let currentXP = user.points ?? 0;
      log('gray', label, 'INFO', `XP: ${currentXP}`);

      // 2. Claim missions yang completed & belum claimed
      const missions = await getMissions(username);
      const claimable = missions.filter(m => m.completed && !m.claimed);

      if (claimable.length > 0) {
        log('cyan', label, 'MISSION', `${claimable.length} misi siap di-claim`);
        for (const m of claimable) {
          try {
            const r = await claimMission(username, m.id);
            if (r.status === 200) {
              currentXP += m.xpReward;
              log('green', label, 'MISSION', `✔ "${m.name}" +${m.xpReward} XP → total: ${currentXP}`);
            } else {
              log('yellow', label, 'MISSION', `"${m.name}" gagal: ${JSON.stringify(r.body).slice(0, 100)}`);
            }
            await sleep(1000);
          } catch (e) {
            log('red', label, 'MISSION', `Exception: ${e.message}`);
          }
        }
      } else {
        log('gray', label, 'MISSION', `Tidak ada misi baru`);
      }

      // 3. Buka vault — prioritas abyss → deep → surface
      let vaultOpened = 0;
      for (const vault of VAULT_PRIORITY) {
        if (currentXP < vault.cost) continue;

        try {
          const r = await openVault(username, walletAddress, vault.type);
          if (r.status === 200) {
            const reward = r.body.reward ?? '?';
            currentXP   = r.body.points ?? (currentXP - vault.cost);
            vaultOpened++;
            log('magenta', label, 'VAULT', `✔ ${vault.type.toUpperCase()} opened | reward: ${reward} | XP sisa: ${currentXP}`);
            await sleep(1500);
            // Cek lagi dari abyss setelah buka
            // (reset loop biar prioritas tetap dari atas)
            break;
          } else if (r.body?.error?.includes('Not enough XP')) {
            // XP kurang, coba tier berikutnya
            continue;
          } else {
            log('yellow', label, 'VAULT', `${vault.type}: ${JSON.stringify(r.body).slice(0, 150)}`);
            break;
          }
        } catch (e) {
          log('red', label, 'VAULT', `Exception: ${e.message}`);
          break;
        }
      }

      // Kalau masih ada XP, loop vault lagi
      if (vaultOpened > 0 && currentXP >= 20) {
        // Ada sisa XP, langsung loop vault lagi tanpa sleep panjang
        await sleep(1500);
        continue;
      }

      if (vaultOpened === 0) {
        log('gray', label, 'VAULT', `XP kurang (${currentXP}) — tunggu misi baru`);
      }

      // Tunggu 1 jam sebelum loop berikutnya
      log('gray', label, 'SLEEP', `Cycle selesai — cek lagi 1 jam`);
      await sleep(60 * 60 * 1000);

    } catch (e) {
      log('red', label, 'ERROR', `Exception: ${e.message}`);
      await sleep(30000);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const wallets = loadWallets();

  console.log(chalk.cyan(`
  ╔══════════════════════════════════════════════════════╗
  ║       Cappuccino v4 — Auto Farmer                   ║
  ╚══════════════════════════════════════════════════════╝`));
  console.log(chalk.gray(`  Wallets : ${wallets.length}`));
  console.log(chalk.gray(`  Tasks   : missions + vault (abyss→deep→surface)\n`));
  wallets.forEach(w => console.log(chalk.gray(`  · ${w.username} | ${w.walletAddress}`)));
  console.log();

  await Promise.all(wallets.map(w => runWallet(w)));
}

main().catch(err => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});
