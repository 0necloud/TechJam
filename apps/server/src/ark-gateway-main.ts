import { createArkGateway, loadArkGatewayConfig } from "./ark-gateway.js";

const config = loadArkGatewayConfig();
const server = createArkGateway(config, {
  onEvent: (event) => process.stdout.write(JSON.stringify({ component: "ark-gateway", ...event }) + "\n"),
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(config.port, config.host, () => {
  process.stdout.write(JSON.stringify({ component: "ark-gateway", event: "ready", host: config.host, port: config.port }) + "\n");
});
