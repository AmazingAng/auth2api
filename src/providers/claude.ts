import express from "express";
import { AccountManager } from "../accounts/manager";
import { Config } from "../config";
import { createChatCompletionsHandler } from "../proxy/handler";
import { createMessagesHandler, createCountTokensHandler } from "../proxy/passthrough";
import { createResponsesHandler } from "../proxy/responses";
import { resolveProviderFromModel } from "./router";
import { Provider, ProviderModel, ProviderStatus } from "./types";

const CLAUDE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
] as const;

export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;

  private readonly chatHandler: express.RequestHandler;
  private readonly responsesHandler: express.RequestHandler;
  private readonly messagesHandler: express.RequestHandler;
  private readonly countTokensHandler: express.RequestHandler;

  constructor(
    private readonly config: Config,
    private readonly manager: AccountManager
  ) {
    this.chatHandler = createChatCompletionsHandler(this.config, this.manager);
    this.responsesHandler = createResponsesHandler(this.config, this.manager);
    this.messagesHandler = createMessagesHandler(this.config, this.manager);
    this.countTokensHandler = createCountTokensHandler(this.config, this.manager);
  }

  supportsModel(model: string): boolean {
    return resolveProviderFromModel(model) === this.name;
  }

  listModels(): ProviderModel[] {
    return CLAUDE_MODELS.map((id) => ({
      id,
      ownedBy: "anthropic",
    }));
  }

  getStatus(): ProviderStatus {
    return {
      name: this.name,
      available: this.manager.accountCount > 0,
      details: {
        accounts: this.manager.getSnapshots(),
        accountCount: this.manager.accountCount,
      },
    };
  }

  handleChatCompletions(): express.RequestHandler {
    return this.chatHandler;
  }

  handleResponses(): express.RequestHandler {
    return this.responsesHandler;
  }

  handleMessages(): express.RequestHandler {
    return this.messagesHandler;
  }

  handleCountTokens(): express.RequestHandler {
    return this.countTokensHandler;
  }
}
