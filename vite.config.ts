import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// build-time version stamp from git: the revision number auto-increments with
// every commit, and the short hash links the build to its source on GitHub
function git(cmd: string, fallback: string): string {
  try { return execSync('git ' + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
}
const APP_REV = git('rev-list --count HEAD', '0');
const APP_HASH = git('rev-parse --short HEAD', 'dev');
// the footer shows the latest COMMIT's time (not the build time) so it always
// reflects the source it was built from; falls back to build time off-git
const BUILD_TIME = git('log -1 --format=%cI', new Date().toISOString());

export default defineConfig({
  base: './',
  define: {
    __APP_REV__: JSON.stringify(APP_REV),
    __APP_HASH__: JSON.stringify(APP_HASH),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    chunkSizeWarningLimit: 1500,
    target: 'es2019'
  }
});
