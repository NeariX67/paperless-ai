const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const AzureOpenAI = require('openai').AzureOpenAI;

const PROVIDERS_PATH = path.join(process.cwd(), 'data', 'providers.json');
const HEALTH_TTL_MS = 60000; // unhealthy providers are retried after this delay
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH']);
const PROVIDER_ERROR_STATUSES = new Set([401, 403, 404, 408, 429]);
const KNOWN_TYPES = ['openai', 'ollama', 'custom', 'azure'];
const MASKED_KEY = '********'; // stands in for a stored API key sent to clients

/** Invalid chain submitted by a client; routes answer it with a 400. */
class ChainError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Store base URLs without trailing slashes, and Ollama URLs as the bare host
 * (no /v1): the native API lives at /api/... and the OpenAI-compatible one at
 * /v1, so each caller appends what it needs.
 */
function cleanBaseUrl(type, url) {
  let clean = (url || '').trim().replace(/\/+$/, '');
  if (type === 'ollama') clean = clean.replace(/\/v1$/, '') || 'http://localhost:11434';
  return clean;
}

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
        // Files saved before URL cleanup may still hold e.g. an Ollama /v1 URL.
        this.providers = parsed.map(p => ({ ...p, baseUrl: cleanBaseUrl(p.type, p.baseUrl) }));
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
        entry.baseUrl = cleanBaseUrl('ollama', src.OLLAMA_API_URL);
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

  /**
   * Parse and normalise a submitted chain (JSON string or array). Throws a
   * ChainError (status 400) for malformed input or unknown provider types.
   * API keys still masked by maskKeys() are restored from the saved chain.
   */
  async prepareChain(input) {
    let list = input;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch (error) {
        throw new ChainError('Invalid provider chain: expected a JSON array');
      }
    }
    if (!Array.isArray(list) || !list.length) {
      throw new ChainError('At least one provider is required');
    }

    const saved = await this.getProviders();
    const seenIds = new Set();
    return list.map((p, i) => {
      if (!p || !KNOWN_TYPES.includes(p.type)) {
        throw new ChainError(`Unknown provider type '${p && p.type}'`);
      }
      let id = p.id || `provider-${i + 1}`;
      while (seenIds.has(id)) id = `${id}-${i + 1}`;
      seenIds.add(id);

      let apiKey = p.apiKey || '';
      if (apiKey === MASKED_KEY) {
        const match = saved.find(s => s.id === p.id);
        apiKey = (match && match.apiKey) || '';
      }

      return {
        id,
        name: p.name || id,
        type: p.type,
        priority: Number(p.priority) || i + 1,
        enabled: p.enabled !== false,
        model: p.model || '',
        apiKey,
        baseUrl: cleanBaseUrl(p.type, p.baseUrl),
        endpoint: p.endpoint || '',
        deploymentName: p.deploymentName || '',
        apiVersion: p.apiVersion || '2023-05-15'
      };
    });
  }

  /** Whether two chains configure the same providers (display names aside). */
  sameChain(a, b) {
    const canonical = list => JSON.stringify(list.map(p => [
      p.id, p.type, Number(p.priority) || 0, p.enabled !== false, p.model || '', p.apiKey || '',
      cleanBaseUrl(p.type, p.baseUrl), p.endpoint || '', p.deploymentName || '',
      p.type === 'azure' ? (p.apiVersion || '2023-05-15') : ''
    ]).sort());
    return canonical(a) === canonical(b);
  }

  /** Copy of a chain with API keys replaced by a placeholder, for clients. */
  maskKeys(list) {
    return list.map(p => ({ ...p, apiKey: p.apiKey ? MASKED_KEY : '' }));
  }

  /**
   * Send a test request to each enabled entry in priority order and record
   * the result in the health cache. With stopAtFirst, stops at the first
   * reachable provider (enough to know the chain works).
   */
  async validateChain(list, { stopAtFirst = false } = {}) {
    const entries = list
      .filter(p => p.enabled !== false)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));
    const errors = [];
    let ok = false;

    for (const entry of entries) {
      const result = await this.validate(entry);
      if (result.ok) {
        ok = true;
        this.markSuccess(entry);
        if (stopAtFirst) break;
      } else {
        this.markFailure(entry, result.error);
        errors.push(`${entry.name || entry.id}: ${result.error}`);
      }
    }
    return { ok, errors };
  }

  async saveProviders(list) {
    const clean = await this.prepareChain(list);

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
    const baseUrl = cleanBaseUrl(entry.type, entry.baseUrl);
    return new OpenAI({
      apiKey: entry.apiKey || (entry.type === 'ollama' ? 'ollama' : 'no-key'),
      ...(baseUrl ? { baseURL: entry.type === 'ollama' ? `${baseUrl}/v1` : baseUrl } : {})
    });
  }

  /** Validate a provider by sending a minimal test request. */
  async validate(entry) {
    try {
      if (entry.type === 'ollama') {
        const response = await axios.post(`${cleanBaseUrl('ollama', entry.baseUrl)}/api/generate`, {
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
module.exports.ChainError = ChainError;
