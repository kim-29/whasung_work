// three.js를 내장한 단일 HTML 도면 템플릿을 dist/viewer-template.html 로 만든다.
// 템플릿 안의 /*__BARS__*/[] 와 /*__INFO__*/{} 자리에 Blender가 바 데이터를 채운다.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['src/viewer.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  write: false,
  target: 'es2019',
});
// </script> 가 번들 안에 있으면 HTML이 깨지므로 이스케이프
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/viewer.html', 'utf8').replace('/*__VIEWER_BUNDLE__*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/viewer-template.html', html);
console.log(`dist/viewer-template.html  ${(html.length / 1024).toFixed(0)} KB`);
