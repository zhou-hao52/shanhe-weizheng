import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'dist', 'shanhe-fc.zip');
const temporary = await mkdtemp(path.join(tmpdir(), 'shanhe-fc-'));
const staging = path.join(temporary, 'app');
const sources = [
  'package.json', 'package-lock.json', 'server', 'account', 'assets', 'art',
  'fonts', 'about', 'admin', 'archive', 'figures', 'quiz', 'route',
  'index.html', '404.html',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: staging, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

function checkName(name) {
  const allowedPublicCertificates = new Set([
    'server/certs/ApsaraDB-CA-Chain.pem',
  ]);
  if (allowedPublicCertificates.has(name)) return;
  if (/^\.env(?:\.|$)|\.(?:sqlite(?:-shm|-wal)?|pem|key|p12|pfx|node)$|[\r\n]/i.test(name)) {
    throw new Error(`Deployment package refuses sensitive or platform-specific file: ${name}`);
  }
}

async function stage(relative) {
  const source = path.join(root, relative);
  const destination = path.join(staging, relative);
  const info = await lstat(source);
  checkName(relative);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    for (const name of (await readdir(source)).sort()) {
      if (name !== '.DS_Store') await stage(path.join(relative, name));
    }
  } else if (info.isFile()) {
    await copyFile(source, destination);
    await chmod(destination, 0o644);
  } else {
    throw new Error(`Deployment package refuses symlink or special file: ${relative}`);
  }
}

async function listFiles(directory, relative = '') {
  const files = [];
  for (const name of (await readdir(path.join(directory, relative))).sort()) {
    const entry = path.join(relative, name);
    checkName(entry);
    const info = await lstat(path.join(directory, entry));
    if (info.isDirectory()) files.push(...await listFiles(directory, entry));
    else if (info.isFile()) files.push(entry);
    else throw new Error(`Deployment package refuses symlink or special file: ${entry}`);
  }
  return files;
}

try {
  await mkdir(staging, { mode: 0o755 });
  for (const source of sources) await stage(source);
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  ]);
  const files = await listFiles(staging);
  const archive = path.join(temporary, 'shanhe-fc.zip');
  run('zip', ['-q', '-X', archive, '-@'], { input: `${files.join('\n')}\n` });
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(archive, output);
  console.log(`FC ZIP ready: ${output} (${files.length} files, no local data or credentials)`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
