import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// GitHub Pages는 /저장소이름/ 아래에서 서비스되므로 상대 경로로 빌드한다.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
