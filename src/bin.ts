import { startServer, setVaultPath } from "./server.js";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--vault-path" || args[i] === "-v") && args[i + 1]) {
    setVaultPath(args[++i]);
  }
}

startServer().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
