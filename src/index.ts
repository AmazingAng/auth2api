import crypto from "crypto";
import readline from "readline";
import { loadConfig, resolveAuthDir } from "./config";
import { AccountManager } from "./accounts/manager";
import { generatePKCECodes } from "./auth/pkce";
import { generateAuthURL, exchangeCodeForTokens } from "./auth/oauth";
import { waitForCallback } from "./auth/callback-server";
import { createServer } from "./server";
import { canStartServer } from "./startup";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function doLogin(authDir: string, manual: boolean): Promise<void> {
  const manager = new AccountManager(authDir);
  manager.load();

  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");

  const authURL = generateAuthURL(state, pkce);
  console.log("\nOpen this URL in your browser to login:\n");
  console.log(authURL);

  let code: string;
  let returnedState: string;

  if (manual) {
    // Manual mode: user pastes the callback URL from browser
    console.log("\nAfter login, your browser will redirect to a localhost URL that may fail to load.");
    console.log("Copy the FULL URL from your browser address bar and paste it here.\n");
    const callbackURL = await prompt("Paste callback URL: ");

    // Parse code and state from the pasted URL
    const url = new URL(callbackURL);
    code = url.searchParams.get("code") || "";
    returnedState = url.searchParams.get("state") || "";

    if (!code) {
      console.error("Error: No authorization code found in URL");
      process.exit(1);
    }
    if (returnedState && returnedState !== state) {
      console.error("Error: State mismatch — possible CSRF attack");
      process.exit(1);
    }
  } else {
    // Auto mode: local callback server
    console.log("\nWaiting for OAuth callback...\n");
    const result = await waitForCallback();
    code = result.code;
    returnedState = result.state;
  }

  console.log("Exchanging code for tokens...");
  const tokenData = await exchangeCodeForTokens(code, returnedState, state, pkce);
  manager.addAccount(tokenData);
  console.log(`\nLogin successful! Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
}

async function startServer(): Promise<void> {
  const configPath = process.argv.find((a) => a.startsWith("--config="))?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  const manager = new AccountManager(authDir);
  manager.load();

  if (!canStartServer(config, manager)) {
    console.log("No provider auth found. Run with --login for Claude or ensure Codex auth exists first.");
    process.exit(1);
  }

  manager.startAutoRefresh();

  const app = createServer(config, manager);
  const host = config.host || "127.0.0.1";
  const port = config.port;

  app.listen(port, host, () => {
    console.log(`auth2api running on http://${host}:${port}`);
    console.log(`Endpoints:`);
    console.log(`  POST /v1/chat/completions`);
    console.log(`  GET  /v1/models`);
    console.log(`  GET  /health`);
  });

  process.on("SIGINT", () => {
    manager.stopAutoRefresh();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  if (args.includes("--login")) {
    const manual = args.includes("--manual");
    await doLogin(authDir, manual);
  } else {
    await startServer();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
