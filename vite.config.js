import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const staticAssetCache = () => {
  const applyHeaders = (_request, response, next) => {
    const pathname = String(_request.url || '').split('?')[0]
    const isBuiltAsset = pathname.startsWith('/assets/')
    const isPublicAsset = /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(pathname)
    if (isBuiltAsset || isPublicAsset) {
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
    next()
  }

  return {
    name: 'static-asset-cache',
    configureServer(server) {
      server.middlewares.use(applyHeaders)
    },
    configurePreviewServer(server) {
      server.middlewares.use(applyHeaders)
    },
  }
}

export default defineConfig({
  plugins: [react(), staticAssetCache()],
  server: { proxy: { '/api': 'http://127.0.0.1:3001', '/private-cafe-console/api': 'http://127.0.0.1:3001' } },
})
