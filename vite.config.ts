import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Let React report malformed document links before Vite's URL decoding rejects the request.
// Serve the SPA shell without changing the browser URL, in both supported serving modes.
function malformedDocumentLinks(): Plugin {
  const middleware = (request: IncomingMessage, _response: ServerResponse, next: () => void) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next()
    const pathname = request.url?.split('?')[0] ?? ''
    if (pathname.startsWith('/file/')) {
      // Consume the result: Vite's config bundler can remove an unused pure decoding call.
      try { if (decodeURIComponent(pathname)) return next() } catch { request.url = '/index.html' }
    }
    next()
  }
  return {
    name: 'malformed-document-links',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [malformedDocumentLinks(), react()],
  server: {
    port: Number(process.env.MD_MANAGER_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.MD_MANAGER_API_PORT ?? 3001}` },
  },
  preview: { host: '127.0.0.1', port: Number(process.env.MD_MANAGER_WEB_PORT ?? 4173), strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.MD_MANAGER_API_PORT ?? 3001}` } },
})
