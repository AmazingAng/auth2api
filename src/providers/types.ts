import express from "express";

export type ProviderName = "claude" | "codex";

export interface ProviderModel {
  id: string;
  ownedBy: string;
}

export interface ProviderStatus {
  name: ProviderName;
  available: boolean;
  details?: unknown;
}

export interface Provider {
  name: ProviderName;
  supportsModel(model: string): boolean;
  listModels(): ProviderModel[];
  getStatus(): ProviderStatus;
  handleChatCompletions(): express.RequestHandler;
  handleResponses(): express.RequestHandler;
  handleMessages?(): express.RequestHandler;
  handleCountTokens?(): express.RequestHandler;
}
