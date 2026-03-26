const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SERVER_CACHE_PORT || 4000);
const HOST = process.env.SERVER_CACHE_HOST || '127.0.0.1';
const targetDir = process.env.SERVER_CACHE_DIR || 'D:\\my-projects\\CmbCowork\\openCode';

function isPortInUse(port, host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(800);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function main() {
  if (await isPortInUse(PORT, HOST)) {
    console.log(`[server:cache] http-server already running at http://${HOST}:${PORT}`);
    return;
  }

  const absoluteTargetDir = path.resolve(targetDir);
  if (!fs.existsSync(absoluteTargetDir)) {
    console.error(`[server:cache] target directory not found: ${absoluteTargetDir}`);
    process.exit(1);
  }

  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(npxBin, ['http-server', '-p', String(PORT)], {
    cwd: absoluteTargetDir,
    detached: true,
    stdio: 'ignore'
  });

  child.unref();
  console.log(`[server:cache] started http-server at http://${HOST}:${PORT} (dir: ${absoluteTargetDir})`);
}

main().catch((error) => {
  console.error('[server:cache] failed to start:', error);
  process.exit(1);
});
