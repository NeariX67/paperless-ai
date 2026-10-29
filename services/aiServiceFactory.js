const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');
const customService = require('./customService');
const azureService = require('./azureService');
const providerRegistry = require('./providerRegistry');

const SERVICE_BY_TYPE = {
  openai: openaiService,
  ollama: ollamaService,
  custom: customService,
  azure: azureService
};

// One service instance per provider entry. The modules export shared
// singletons, so binding them to an entry would let concurrent requests switch
// each other's client/model mid-call; instead each entry gets its own instance.
const instances = new Map();

class AIServiceFactory {
  /** Single service for the configured provider (legacy behaviour). */
  static getService() {
    return SERVICE_BY_TYPE[config.aiProvider] || openaiService;
  }

  /** Service instance bound to a provider-chain entry (null for unknown types). */
  static getServiceFor(entry) {
    const singleton = SERVICE_BY_TYPE[entry.type];
    if (!singleton) return null;
    const key = JSON.stringify(entry);
    let service = instances.get(key);
    if (!service) {
      service = new singleton.constructor();
      service.setProvider(entry);
      instances.set(key, service);
    }
    return service;
  }

  /**
   * Execute fn(service, entry) across the provider chain in priority order.
   * Falls back to the next provider when one throws, returns a result with an
   * `error` property, or is currently marked unhealthy (circuit breaker). Only
   * provider-level failures (unreachable, auth, rate limit, 5xx) count against
   * a provider's health; content errors such as unparseable model output just
   * move on to the next provider.
   */
  static async execute(fn, opts = {}) {
    const chain = await providerRegistry.getChain();
    const errors = [];
    const skipped = [];

    const attempt = async (entry) => {
      const service = this.getServiceFor(entry);
      if (!service) {
        errors.push(`${entry.name}: unknown provider type '${entry.type}'`);
        return { done: false };
      }

      try {
        const result = await fn(service, entry);
        if (result && result.error) {
          if (result.providerError) providerRegistry.markFailure(entry, result.error);
          errors.push(`${entry.name}: ${result.error}`);
          return { done: false };
        }
        providerRegistry.markSuccess(entry);
        if (result && typeof result === 'object') {
          result.provider = { id: entry.id, name: entry.name, type: entry.type, model: entry.model };
        }
        return { done: true, result };
      } catch (error) {
        if (error.providerError || providerRegistry.isProviderError(error)) {
          providerRegistry.markFailure(entry, error.message);
        }
        errors.push(`${entry.name}: ${error.message}`);
        console.error(`[ERROR] provider '${entry.name}' failed, trying next in chain:`, error.message);
        return { done: false };
      }
    };

    for (const entry of chain) {
      // Circuit breaker: skip providers known to be unhealthy unless the caller
      // explicitly asks to try them anyway (opts.allowUnhealthy === true).
      if (opts.allowUnhealthy !== true && providerRegistry.isUnhealthy(entry)) {
        skipped.push(entry);
        errors.push(`${entry.name}: skipped (unhealthy: ${providerRegistry.getHealth()[entry.id]?.lastError || 'no result yet'})`);
        continue;
      }
      const outcome = await attempt(entry);
      if (outcome.done) return outcome.result;
    }

    // Half-open: when every provider was skipped as unhealthy, nothing was
    // tried at all. Probe the one that failed longest ago instead of failing
    // outright, so a single-provider setup recovers on its own.
    if (skipped.length && skipped.length === chain.length) {
      const health = providerRegistry.getHealth();
      const probe = skipped.reduce((oldest, entry) =>
        (health[entry.id]?.checkedAt || 0) < (health[oldest.id]?.checkedAt || 0) ? entry : oldest);
      const outcome = await attempt(probe);
      if (outcome.done) return outcome.result;
    }

    throw new Error(`All providers failed: ${errors.join(' | ')}`);
  }
}

module.exports = AIServiceFactory;
