import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { resolve } from 'node:path'
import { createCaseboardApi } from './electron/caseboard/local-server'
import { NativeArchiveService } from './electron/caseboard/native-client'

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 3017, strictPort: true },
  build: {
    outDir: 'caseboard-dist',
    rollupOptions: { input: resolve(process.cwd(), 'caseboard.html') },
  },
  plugins: [
    react(),
    { name: 'caseboard-default-page', configureServer(server) {
      const api = createCaseboardApi('http://127.0.0.1:3017', new NativeArchiveService({ workerPath: resolve(process.cwd(), 'dist-caseboard-electron/native-worker.js'), dataRoot: resolve(process.cwd(), '.caseboard-data'), keyHelperPath: resolve(process.cwd(), 'resources/caseboard/key-reader', process.platform, process.platform === 'win32' ? 'yaozhuo-key-reader.exe' : 'yaozhuo-key-reader') }))
      server.httpServer?.once('close', () => api.close())
      server.middlewares.use((req, res, next) => {
        void api.handle(req, res).then(handled => { if (!handled) next() }).catch(() => { if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: '本地服务暂时不可用，请重试。' })) } else res.end() })
      })
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/caseboard.html' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')
        next()
      })
    } },
    electron([
      {
        entry: 'electron/caseboard/native-worker.ts',
        onstart() {},
        vite: { build: { outDir: 'dist-caseboard-electron', rollupOptions: { output: { entryFileNames: 'native-worker.js' } } } },
      },
      {
        entry: 'electron/caseboard/preload.ts',
        onstart() {},
        vite: { build: { outDir: 'dist-caseboard-electron', rollupOptions: { output: { entryFileNames: 'preload.js' } } } },
      },
      {
        entry: 'electron/caseboard/main.ts',
        onstart: async ({ startup }) => { if (process.env.CASEBOARD_DESKTOP === '1') await startup(['dist-caseboard-electron/main.js']) },
        vite: { build: { outDir: 'dist-caseboard-electron', rollupOptions: { output: { entryFileNames: 'main.js' } } } },
      },
    ]),
  ],
})
