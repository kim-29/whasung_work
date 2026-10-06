import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      testTimeout: 30000, // 일부 테스트는 시간 경과(1초 이상)를 기다린다
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          // Durable Object(SQLite)가 있으면 격리 스토리지가 실패해서 끈다 (테스트끼리 DB를 공유하므로 순서 주의)
          isolatedStorage: false,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_PIN: '123456',
              PIN_PEPPER: 'test-pepper',
              BLENDER_API_KEY: 'test-key',
            },
          },
        },
      },
    },
  };
});
