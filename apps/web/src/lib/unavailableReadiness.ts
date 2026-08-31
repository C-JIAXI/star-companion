import type { ReadinessDTO } from "../types";

export const createUnavailableReadiness = (): ReadinessDTO => ({
  serverReachable: false,
  appLocked: false,
  hasCharacter: false,
  hasAvailableCharacter: false,
  hasChat: false,
  hasProvider: false,
  hasApiKey: false,
  hasActiveModel: false,
  chatModuleAssigned: false,
  chatModelSupportsText: false,
  visionAvailable: false,
  budgetAllowsChat: false,
  configurationValid: false,
  ready: false,
  overallStatus: "server_unreachable",
  connectionStatus: {
    status: "failed",
    mode: null,
    testId: null,
    providerKind: null,
    providerId: null,
    modelId: null,
    checkedAt: null,
    errorCode: "connection_failed",
    diagnosticId: null,
    summary: null,
    retryable: true,
    suggestedAction: "retry_server",
    mayIncurCost: false
  },
  nextRecommendedAction: "retry_server",
  issues: [],
  characterCount: 0,
  chatCount: 0,
  computedAt: new Date().toISOString()
});
