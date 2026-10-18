import { buildApp } from "./app.js";
import { closeDatabase, migrate, openDatabase } from "./db.js";
import { startScheduler } from "./scheduler.js";
import { seedSites } from "./sources/index.js";

export function openConfiguredDatabase(config) {
  return openDatabase(config.database.driver === "mysql" ? { driver: "mysql", mysql: config.database.mysql } : config.database.sqlitePath);
}

export async function serve({ config }) {
  const db = openConfiguredDatabase(config);
  await migrate(db);
  await seedSites(db);
  const app = await buildApp({ config, db, deps: { ownsDatabase: true } });
  await app.listen({ port: config.port, host: config.host });
  const scheduler = config.schedule.enabled
    ? startScheduler({ db, config, log: (message) => app.log.info(message) })
    : null;
  const shutdown = async () => {
    scheduler?.stop();
    await app.close();
    await closeDatabase(db);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { app, db };
}
