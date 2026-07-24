import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ config });

async function start() {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error(error, "failed to start");
    process.exitCode = 1;
  }
}

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

void start();
