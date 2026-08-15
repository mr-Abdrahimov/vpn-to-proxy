import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { nodeRoutes } from './nodes.js';
import { proxyRoutes } from './proxies.js';
import { settingsRoutes } from './settings.js';
import { subscriptionRoutes } from './subscriptions.js';
import { systemRoutes } from './system.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(subscriptionRoutes);
  await app.register(nodeRoutes);
  await app.register(proxyRoutes);
  await app.register(settingsRoutes);
  await app.register(systemRoutes);
}
