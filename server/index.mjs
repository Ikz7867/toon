import { createApp } from './app.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (process.env.STUDIO_PASSWORD?.length ?? 0) < 16) {
  console.error('Set STUDIO_PASSWORD to at least 16 characters before exposing the studio beyond loopback.'); process.exit(1);
}
const app = createApp();
app.server.listen(port, host, () => { console.log(`Toon Studio listening on ${host}:${port}`); app.engine.start(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
