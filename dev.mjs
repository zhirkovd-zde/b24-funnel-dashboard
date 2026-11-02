// Локальный запуск на выдуманных данных, без ключей и без портала:
//   npm run dev            — обычные данные
//   MOCK_SCENARIO=empty npm run dev   — пустой портал (также: huge, partial, error)
process.env.MOCK = '1';
process.env.NODE_ENV = 'development';
await import('./server.js');
