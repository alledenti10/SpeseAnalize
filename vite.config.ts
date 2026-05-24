import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      'tower-gentle-chief-immune.trycloudflare.com',
      'carmen-highlight-sellers-provision.trycloudflare.com',
    ],
  },
})
