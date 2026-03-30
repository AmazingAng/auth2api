import { AccountManager } from "./accounts/manager";
import { Config } from "./config";
import { CodexProvider } from "./providers/codex";

export function canStartServer(config: Config, manager: AccountManager): boolean {
  if (manager.accountCount > 0) {
    return true;
  }

  const codexProvider = new CodexProvider(config);
  return codexProvider.getStatus().available;
}
