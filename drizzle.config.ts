import { defineConfig } from 'drizzle-kit'

// drizzle-kit generate 가 이 설정으로 schema.ts 를 읽어 drizzle/ 에 SQL 마이그레이션을 만든다
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './drizzle'
})
