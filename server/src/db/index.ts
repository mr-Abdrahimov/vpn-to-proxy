import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { allModels } from './models.js';

export * from './models.js';

// Запрещаем «тихую» фильтрацию по неописанным в схеме полям.
mongoose.set('strictQuery', true);

let connected = false;

export async function connectDatabase(log: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> {
  if (connected) return;

  mongoose.connection.on('disconnected', () => log.warn('MongoDB: соединение потеряно, идёт переподключение…'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB: соединение восстановлено'));

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    // Панель — приложение с низкой конкурентностью, большой пул ни к чему.
    maxPoolSize: 10,
    autoIndex: false,
  });

  // Индексы строим явно и один раз на старте: autoIndex:false исключает
  // неожиданные блокировки при первом обращении к коллекции под нагрузкой.
  await Promise.all(allModels.map((m) => m.createIndexes()));

  connected = true;
  log.info(`MongoDB подключена: ${redactUri(env.MONGODB_URI)}`);
}

export async function closeDatabase(): Promise<void> {
  if (!connected) return;
  await mongoose.connection.close();
  connected = false;
}

export function isDatabaseHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Убирает пароль из строки подключения, чтобы он не попал в логи. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
}

export { mongoose };
