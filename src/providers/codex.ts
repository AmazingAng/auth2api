import express from "express";
import { Config } from "../config";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { createCodexChatCompletionsHandler } from "./codex-chat";
import { createCodexResponsesHandler } from "./codex-responses";
import { resolveProviderFromModel } from "./router";
import { Provider, ProviderModel, ProviderStatus } from "./types";

const DEFAULT_CODEX_CONFIG = {
  enabled: true,
  "auth-file": "~/.codex/auth.json",
  models: [] as string[],
};

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

export class CodexProvider implements Provider {
  readonly name = "codex" as const;

  private readonly authStore: CodexAuthStore;
  private readonly codexConfig;
  private readonly chatHandler: express.RequestHandler;
  private readonly responsesHandler: express.RequestHandler;

  constructor(private readonly config: Config) {
    this.codexConfig = this.config.codex || DEFAULT_CODEX_CONFIG;
    this.authStore = new CodexAuthStore(this.codexConfig["auth-file"]);
    this.chatHandler = createCodexChatCompletionsHandler(this.authStore);
    this.responsesHandler = createCodexResponsesHandler(this.authStore);
  }

  supportsModel(model: string): boolean {
    if (!this.codexConfig.enabled || typeof model !== "string") {
      return false;
    }

    const normalized = normalizeModelId(model);
    if (!normalized || resolveProviderFromModel(normalized) !== this.name) {
      return false;
    }

    return this.codexConfig.models
      .map((id) => normalizeModelId(id))
      .includes(normalized);
  }

  listModels(): ProviderModel[] {
    if (!this.codexConfig.enabled) {
      return [];
    }

    return this.codexConfig.models.map((id) => ({
      id,
      ownedBy: "openai",
    }));
  }

  getStatus(): ProviderStatus {
    if (!this.codexConfig.enabled) {
      return {
        name: this.name,
        available: false,
        details: { enabled: false },
      };
    }

    if (this.codexConfig.models.length === 0) {
      return {
        name: this.name,
        available: false,
        details: {
          enabled: true,
          configured: false,
          error: "No Codex models configured",
        },
      };
    }

    try {
      const snapshot = this.authStore.load();
      return {
        name: this.name,
        available: true,
        details: {
          enabled: true,
          configured: true,
          authMode: snapshot.authMode,
          accountId: snapshot.accountId,
          lastRefresh: snapshot.lastRefresh,
          path: snapshot.path,
        },
      };
    } catch (error) {
      if (error instanceof CodexAuthError) {
        return {
          name: this.name,
          available: false,
          details: {
            enabled: true,
            configured: true,
            error: error.message,
          },
        };
      }
      throw error;
    }
  }

  handleChatCompletions(): express.RequestHandler {
    return this.chatHandler;
  }

  handleResponses(): express.RequestHandler {
    return this.responsesHandler;
  }
}
