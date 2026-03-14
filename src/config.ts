import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

export interface CloakingConfig {
  mode: "auto" | "always" | "never";
  "strict-mode": boolean;
  "sensitive-words": string[];
  "cache-user-id": boolean;
}

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": string[];
  cloaking: CloakingConfig;
  debug: boolean;
}

const DEFAULT_CONFIG: Config = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  cloaking: {
    mode: "auto",
    "strict-mode": false,
    "sensitive-words": [],
    "cache-user-id": false,
  },
  debug: false,
};

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let config: Config;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    config = { ...DEFAULT_CONFIG };
  } else {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw) as Partial<Config>;
    config = {
      ...DEFAULT_CONFIG,
      ...parsed,
      cloaking: { ...DEFAULT_CONFIG.cloaking, ...(parsed.cloaking || {}) },
    };
  }

  // Auto-generate API key if none configured
  if (!config["api-keys"] || config["api-keys"].length === 0) {
    const key = generateApiKey();
    config["api-keys"] = [key];
    // Write config with generated key
    fs.writeFileSync(filePath, yaml.dump(config, { lineWidth: -1 }), { mode: 0o600 });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return config;
}
