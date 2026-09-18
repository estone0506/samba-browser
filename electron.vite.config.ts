import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // .env 의 SAMBA_* 값(Supabase URL·anon 키)을 메인 번들에 주입한다
    envPrefix: ['MAIN_VITE_', 'SAMBA_'],
    build: {
      rollupOptions: {
        // 네이티브 바이너리(.node/.dll)를 품고 있어 번들할 수 없다 — 런타임 require 로 남긴다
        external: ['onnxruntime-node']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          renderer: resolve('src/preload/renderer.ts'),
          page: resolve('src/preload/page.ts')
        }
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        // 다중 페이지: 앱 UI(index)와 자체 새 탭 페이지(newtab, samba:// 로 서빙)
        input: {
          index: resolve('src/renderer/index.html'),
          newtab: resolve('src/renderer/newtab.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
