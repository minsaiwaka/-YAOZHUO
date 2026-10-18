const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const helperBuild = spawnSync(process.execPath, [path.join(root, 'scripts/build-key-reader.cjs')], { cwd: root, stdio: 'inherit', windowsHide: true })
if (helperBuild.status !== 0) process.exit(helperBuild.status || 1)
const childEnv = { ...process.env, CASEBOARD_DESKTOP: '1' }
delete childEnv.ELECTRON_STARTUP_PREVENT
const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.caseboard.config.ts'], { cwd: root, env: childEnv, stdio: 'inherit' })
child.on('exit', code => process.exit(code || 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
