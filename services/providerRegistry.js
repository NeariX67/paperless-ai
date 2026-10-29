const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const AzureOpenAI = require('openai').AzureOpenAI;

const PROVIDERS_PATH = path.join(process.cwd(), 'data', 'providers.json');
const HEALTH_TTL_MS = 60000; // unhealthy providers are retried after this delay
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH']);
const PROVIDER_ERROR_STATUSES = new Set([401, 403, 404, 408, 429]);

/**
 * Central provider chain. Providers are stored in data/providers.json as a
 * priority-ordered list; when the file does not exist the chain falls back to
 * the single legacy provider from the environment, so existing setups keep
 * working unchanged.
 */
class ProviderRegistry {
  constructor() {
    this.providers = null;
    this.health = new Map(); // entryId -> { ok, checkedAt, lastError, fails }
  }

  /** Load the chain (async, cached). Legacy env entry when no file exists. */
  async getProviders() {
    return (await this.loadSaved()) || [this.legacyEntry()];
  }

  /** The saved chain from providers.json (cached), or null when there is none. */
  async loadSaved() {
    if (this.providers && this.providers.length) return this.providers;
    try {
      const raw = await fs.readFile(PROVIDERS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        this.providers = parsed;
        return this.providers;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Error loading providers.json:', error.message);
    }
    return null;
  }

  /** Build a provider entry from the legacy single-provider env vars. */
  legacyEntry(override) {
    const src = override || process.env;
    const type = src.AI_PROVIDER || 'openai';
    const entry = { id: 'primary', name: 'Primary', type, priority: 1, enabled: true };
    switch (type) {
      case 'openai':
        entry.apiKey = src.OPENAI_API_KEY || '';
        entry.model = src.OPENAI_MODEL || 'gpt-4o-mini';
        break;
      case 'ollama':
        entry.baseUrl = src.OLLAMA_API_URL || 'http://localhost:11434';
        entry.model = src.OLLAMA_MODEL || 'llama3.2';
        break;
      case 'custom':
        entry.baseUrl = src.CUSTOM_BASE_URL || '';
        entry.apiKey = src.CUSTOM_API_KEY || '';
        entry.model = src.CUSTOM_MODEL || '';
        break;
      case 'azure':
        entry.apiKey = src.AZURE_API_KEY || '';
        entry.endpoint = src.AZURE_ENDPOINT || '';
        entry.deploymentName = src.AZURE_DEPLOYMENT_NAME || '';
        entry.apiVersion = src.AZURE_API_VERSION || '2023-05-15';
        entry.model = entry.deploymentName;
        break;
    }
    return entry;
  }

  /** Enabled providers sorted by priority (1 = best). */
  async getChain() {
    const providers = await this.getProviders();
    return providers
      .filter(p => p.enabled !== false)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));
  }

  /** Resolve the entry for a service provider type (openai/ollama/custom/azure). */
  async resolveFor(type) {
    const providers = await this.getProviders();
    const entry = providers.find(p => p.type === type && p.enabled !== false);
    return entry || this.legacyEntry();
  }

  async saveProviders(list) {
    const clean = (Array.isArray(list) ? list : [])
      .filter(p => p && p.type)
      .map((p, i) => ({
        id: p.id || `provider-${i + 1}`,
        name: p.name || p.id || `Provider ${i + 1}`,
        type: p.type,
        priority: Number(p.priority) || i + 1,
        enabled: p.enabled !== false,
        model: p.model || '',
        apiKey: p.apiKey || '',
        baseUrl: p.baseUrl || '',
        endpoint: p.endpoint || '',
        deploymentName: p.deploymentName || '',
        apiVersion: p.apiVersion || '2023-05-15'
      }));
    if (!clean.length) throw new Error('At least one provider is required');

    await fs.mkdir(path.dirname(PROVIDERS_PATH), { recursive: true });
    await fs.writeFile(PROVIDERS_PATH, JSON.stringify(clean, null, 2));
    this.providers = clean;
    this.health.clear();

    // Mirror the top-priority entry into the legacy env vars so any code path
    // that still reads process.env stays consistent.
    const top = clean.find(p => p.enabled) || clean[0];
    process.env.AI_PROVIDER = top.type;
    if (top.type === 'openai') {
      process.env.OPENAI_API_KEY = top.apiKey;
      process.env.OPENAI_MODEL = top.model;
    } else if (top.type === 'ollama') {
      process.env.OLLAMA_API_URL = top.baseUrl || 'http://localhost:11434';
      process.env.OLLAMA_MODEL = top.model;
    } else if (top.type === 'custom') {
      process.env.CUSTOM_BASE_URL = top.baseUrl;
      process.env.CUSTOM_API_KEY = top.apiKey;
      process.env.CUSTOM_MODEL = top.model;
    } else if (top.type === 'azure') {
      process.env.AZURE_API_KEY = top.apiKey;
      process.env.AZURE_ENDPOINT = top.endpoint;
      process.env.AZURE_DEPLOYMENT_NAME = top.deploymentName;
      process.env.AZURE_API_VERSION = top.apiVersion;
    }
    return clean;
  }

  /** Build an OpenAI-compatible (or Azure) client from a provider entry. */
  buildClient(entry) {
    if (entry.type === 'azure') {
      return new AzureOpenAI({
        apiKey: entry.apiKey,
        endpoint: entry.endpoint,
        deploymentName: entry.deploymentName,
        apiVersion: entry.apiVersion || '2023-05-15'
      });
    }
    return new OpenAI({
      apiKey: entry.apiKey || (entry.type === 'ollama' ? 'ollama' : 'no-key'),
      ...(entry.baseUrl ? { baseURL: entry.type === 'ollama' && !entry.baseUrl.endsWith('/v1') ? `${entry.baseUrl}/v1` : entry.baseUrl } : {})
    });
  }

  /** Validate a provider by sending a minimal test request. */
  async validate(entry) {
    try {
      if (entry.type === 'ollama') {
        const response = await axios.post(`${(entry.baseUrl || 'http://localhost:11434').replace(/\/v1$/, '')}/api/generate`, {
          model: entry.model,
          prompt: 'Test',
          stream: false
        }, { timeout: 20000 });
        const ok = response.data && response.data.response;
        return { ok, error: ok ? null : 'No response from Ollama' };
      }

      const client = this.buildClient(entry);
      const completion = await client.chat.completions.create({
        model: entry.model,
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 10
      });
      const ok = completion && completion.choices && completion.choices.length > 0;
      return { ok, error: ok ? null : 'No choices returned' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // --- Health / circuit breaker -------------------------------------------

  /**
   * Whether an error says the provider itself is unusable (unreachable,
   * misconfigured, rate limited, server error) rather than that one request or
   * document went wrong. Only these trip the circuit breaker.
   */
  isProviderError(error) {
    if (!error) return false;
    if (error.providerError === true) return true;
    if (NETWORK_ERROR_CODES.has(error.code)) return true;
    if (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError') return true;
    if (/client not initialized/i.test(error.message || '')) return true;

    // OpenAI SDK errors carry .status; axios errors carry .response.status.
    const status = error.status || (error.response && error.response.status);
    if (status) return PROVIDER_ERROR_STATUSES.has(status) || status >= 500;
    // Axios request that never got a response.
    return Boolean(error.isAxiosError && !error.response);
  }

  isUnhealthy(entry) {
    const h = this.health.get(entry.id);
    if (!h) return false;
    if (h.ok) return false;
    return Date.now() - h.checkedAt < HEALTH_TTL_MS;
  }

  markSuccess(entry) {
    this.health.set(entry.id, { ok: true, checkedAt: Date.now(), lastError: null, fails: 0 });
  }

  markFailure(entry, message) {
    const h = this.health.get(entry.id) || { ok: true, checkedAt: 0, lastError: null, fails: 0 };
    this.health.set(entry.id, { ok: false, checkedAt: Date.now(), lastError: message, fails: h.fails + 1 });
  }

  getHealth() {
    return Object.fromEntries(
      [...this.health.entries()].map(([id, h]) => [id, { ...h }])
    );
  }

  resetHealth() {
    this.health.clear();
  }
}

module.exports = new ProviderRegistry();
