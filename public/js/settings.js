//settings.js
// Theme Management
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }

    initialize() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        
        this.themeToggle.addEventListener('click', () => this.toggleTheme());
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        
        const icon = this.themeToggle.querySelector('i');
        icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setTheme(newTheme);
    }
}

class FormManager {
    constructor() {
        this.form = document.getElementById('setupForm');
        this.tokenLimit = document.getElementById('tokenLimit'); 
        this.responseTokens = document.getElementById('responseTokens'); 
        this.showTags = document.getElementById('showTags');
        this.aiProcessedTag = document.getElementById('aiProcessedTag');
        this.usePromptTags = document.getElementById('usePromptTags');
        this.systemPrompt = document.getElementById('systemPrompt');
        this.systemPromptBtn = document.getElementById('systemPromptBtn');
        this.disableAutomaticProcessing = document.getElementById('disableAutomaticProcessing');
        this.initialize();
    }

    initialize() {
        this.toggleTagsInput();
        this.handleDisableAutomaticProcessing();
        
        this.tokenLimit.addEventListener('input', () => this.validateTokenLimit()); 
        this.responseTokens.addEventListener('input', () => this.validateResponseTokens()); 
        this.showTags.addEventListener('change', () => this.toggleTagsInput());
        this.aiProcessedTag.addEventListener('change', () => this.toggleAiTagInput());
        this.usePromptTags.addEventListener('change', () => this.togglePromptTagsInput());
        this.disableAutomaticProcessing.addEventListener('change', () => this.handleDisableAutomaticProcessing());
        
        this.initializePasswordToggles();

        if (this.usePromptTags.value === 'yes') {
            this.disablePromptElements();
        }
        
        this.toggleAiTagInput();
        this.togglePromptTagsInput();
    }

    validateTokenLimit() {
        const value = parseInt(this.tokenLimit.value, 10);
        if (isNaN(value) || value < 1) {
            this.tokenLimit.setCustomValidity('Token Limit must be a positive integer.');
        } else {
            this.tokenLimit.setCustomValidity('');
        }
    }

    validateResponseTokens() {
        const value = parseInt(this.responseTokens.value, 10);
        if (isNaN(value) || value < 0) {
            this.responseTokens.setCustomValidity('Response tokens must be a non-negative integer.');
        } else {
            this.responseTokens.setCustomValidity('');
        }
    }

    handleDisableAutomaticProcessing() {
        // Create a hidden input if it doesn't exist
        let hiddenInput = document.getElementById('disableAutomaticProcessingValue');
        if (!hiddenInput) {
            hiddenInput = document.createElement('input');
            hiddenInput.type = 'hidden';
            hiddenInput.id = 'disableAutomaticProcessingValue';
            hiddenInput.name = 'disableAutomaticProcessing';
            this.form.appendChild(hiddenInput);
        }
        
        // Update the hidden input value based on checkbox state
        hiddenInput.value = this.disableAutomaticProcessing.checked ? 'yes' : 'no';
    }

    // Rest of the class methods remain the same
    toggleTagsInput() {
        const showTags = this.showTags.value;
        const tagsInputSection = document.getElementById('tagsInputSection');
        
        if (showTags === 'yes') {
            tagsInputSection.classList.remove('hidden');
        } else {
            document.getElementById('tags').value = '';
            tagsInputSection.classList.add('hidden');
        }
    }

    toggleAiTagInput() {
        const showAiTag = this.aiProcessedTag.value;
        const aiTagNameSection = document.getElementById('aiTagNameSection');
        
        if (showAiTag === 'yes') {
            aiTagNameSection.classList.remove('hidden');
        } else {
            aiTagNameSection.classList.add('hidden');
        }
    }

    togglePromptTagsInput() {
        const usePromptTags = this.usePromptTags.value;
        const promptTagsSection = document.getElementById('promptTagsSection');
        
        if (usePromptTags === 'yes') {
            promptTagsSection.classList.remove('hidden');
            this.disablePromptElements();
        } else {
            promptTagsSection.classList.add('hidden');
            this.enablePromptElements();
        }
    }

    disablePromptElements() {
        this.systemPrompt.disabled = true;
        this.systemPromptBtn.disabled = true;
        this.systemPrompt.classList.add('opacity-50', 'cursor-not-allowed');
        this.systemPromptBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }

    enablePromptElements() {
        this.systemPrompt.disabled = false;
        this.systemPromptBtn.disabled = false;
        this.systemPrompt.classList.remove('opacity-50', 'cursor-not-allowed');
        this.systemPromptBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    initializePasswordToggles() {
        document.querySelectorAll('[data-input]').forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                const inputId = e.currentTarget.dataset.input;
                this.togglePassword(inputId);
            });
        });
    }

    togglePassword(inputId) {
        const input = document.getElementById(inputId);
        const icon = input.nextElementSibling.querySelector('i');
        
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    }
}

// Tags Management
class TagsManager {
    constructor(
        tagInputId,
        tagsContainerId,
        tagsHiddenInputId
    ) {
        this.tagInput = document.getElementById(tagInputId); //'tagInput'
        this.tagsContainer = document.getElementById(tagsContainerId); // tagsContainer
        this.tagsHiddenInput = document.getElementById(tagsHiddenInputId); // tagsHiddenInput
        this.addTagButton = this.tagInput?.closest('.space-y-2')?.querySelector('button');
        
        if (this.tagInput && this.tagsContainer && this.addTagButton) {
            this.initialize();
            
            // Initialize existing tags with proper event handlers
            this.initializeExistingTags();
        }
    }

    initialize() {
        if (this.addTagButton) {
            this.addTagButton.addEventListener('click', () => this.addTag());
        }
        
        if (this.tagInput) {
            this.tagInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addTag();
                }
            });
        }
    }

    initializeExistingTags() {
        const existingTags = this.tagsContainer.querySelectorAll('.bg-blue-100');
        existingTags.forEach(tagElement => {
            const removeButton = tagElement.querySelector('button');
            if (removeButton) {
                this.initializeTagRemoval(removeButton);
            }
        });
    }

    initializeTagRemoval(button) {
        button.addEventListener('click', async () => {
            const result = await Swal.fire({
                title: 'Remove Tag',
                text: 'Are you sure you want to remove this tag?',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, remove it',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#d33',
                cancelButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });

            if (result.isConfirmed) {
                const tagElement = button.closest('.bg-blue-100');
                if (tagElement) {
                    tagElement.remove();
                    this.updateHiddenInput();
                }
            }
        });
    }

    async addTag() {
        if (!this.tagInput) return;

        const tagText = this.tagInput.value.trim();
        const specialChars = /[,;:\n\r\\/]/;
        
        if (specialChars.test(tagText)) {
            await Swal.fire({
                title: 'Invalid Characters',
                text: 'Tags cannot contain commas, semi-colons, colons, or line breaks.',
                icon: 'warning',
                confirmButtonText: 'OK',
                confirmButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });
            return;
        }

        if (tagText) {
            const tag = this.createTagElement(tagText);
            this.tagsContainer.appendChild(tag);
            this.updateHiddenInput();
            this.tagInput.value = '';
        }
    }

    createTagElement(text) {
        const tag = document.createElement('div');
        tag.className = 'bg-blue-100 text-blue-800 px-3 py-1 rounded-full flex items-center gap-2 animate-fade-in';
        
        const tagText = document.createElement('span');
        tagText.textContent = text;
        
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'hover:text-blue-600';
        removeButton.innerHTML = '<i class="fas fa-times"></i>';
        
        this.initializeTagRemoval(removeButton);

        tag.appendChild(tagText);
        tag.appendChild(removeButton);
        
        return tag;
    }

    updateHiddenInput() {
        if (!this.tagsHiddenInput || !this.tagsContainer) return;
        
        const tags = Array.from(this.tagsContainer.querySelectorAll('.bg-blue-100 span'))
            .map(span => span.textContent.trim())
            .filter(tag => tag); // Remove any empty tags
            
        this.tagsHiddenInput.value = tags.join(',');
    }
}

// Prompt Management
class PromptManager {
    constructor() {
        this.systemPrompt = document.getElementById('systemPrompt');
        this.exampleButton = document.getElementById('systemPromptBtn');
        this.initialize();
    }

    initialize() {
        this.exampleButton.addEventListener('click', () => this.prefillExample());
    }

    prefillExample() {
        const examplePrompt = `You are a personalized document analyzer. Your task is to analyze documents and extract relevant information.

Analyze the document content and extract the following information into a structured JSON object:

1. title: Create a concise, meaningful title for the document
2. correspondent: Identify the sender/institution but do not include addresses
3. tags: Select up to 4 relevant thematic tags
4. document_date: Extract the document date (format: YYYY-MM-DD)
5. document_type: Determine a precise type that classifies the document (e.g. Invoice, Contract, Employer, Information and so on)
6. language: Determine the document language (e.g. "de" or "en")
      
Important rules for the analysis:

For tags:
- FIRST check the existing tags before suggesting new ones
- Use only relevant categories
- Maximum 4 tags per document, less if sufficient (at least 1)
- Avoid generic or too specific tags
- Use only the most important information for tag creation
- The output language is the one used in the document! IMPORTANT!

For the title:
- Short and concise, NO ADDRESSES
- Contains the most important identification features
- For invoices/orders, mention invoice/order number if available
- The output language is the one used in the document! IMPORTANT!

For the correspondent:
- Identify the sender or institution
  When generating the correspondent, always create the shortest possible form of the company name (e.g. "Amazon" instead of "Amazon EU SARL, German branch")

For the document date:
- Extract the date of the document
- Use the format YYYY-MM-DD
- If multiple dates are present, use the most relevant one

For the language:
- Determine the document language
- Use language codes like "de" for German or "en" for English
- If the language is not clear, use "und" as a placeholder`;

        this.systemPrompt.value = examplePrompt;
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const themeManager = new ThemeManager();
    const formManager = new FormManager();
    const tagsManager = new TagsManager('tagInput','tagsContainer','tags');
    const promptTagsManager = new TagsManager('promptTagInput','promptTagsContainer','promptTags');
    const promptManager = new PromptManager();

    // Initialize textarea newlines
    const systemPromptTextarea = document.getElementById('systemPrompt');
    systemPromptTextarea.value = systemPromptTextarea.value.replace(/\\n/g, '\n');
});

// Form Submission Handler
document.addEventListener('DOMContentLoaded', (event) => {
    const systemPromptTextarea = document.getElementById('systemPrompt');
    systemPromptTextarea.value = systemPromptTextarea.value.replace(/\\n/g, '\n');

    // Form submission handler
    const setupForm = document.getElementById('setupForm');
    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = setupForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

        try {

            const formData = new FormData(setupForm);
            //remove from formData.systemPrompt all ` chars
            if (formData.get('systemPrompt')) {
                formData.set('systemPrompt', formData.get('systemPrompt').replace(/`/g, ''));
            }
            const response = await fetch('/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(Object.fromEntries(formData))
            });

            const result = await response.json();

            if (result.success) {
                await Swal.fire({
                    icon: 'success',
                    title: 'Success!',
                    text: result.message,
                    timer: 2000,
                    showConfirmButton: false
                });

                if (result.restart) {
                    let countdown = 5;
                    const alert = Swal.fire({
                        title: 'Restarting...',
                        text: `Application will restart in ${countdown} seconds`,
                        icon: 'info',
                        showConfirmButton: false,
                        allowOutsideClick: false
                    });

                    const countdownInterval = setInterval(() => {
                        countdown--;
                        if (countdown < 0) {
                            clearInterval(countdownInterval);
                            window.location.reload();
                        } else {
                            Swal.update({
                                text: `Application will restart in ${countdown} seconds`
                            });
                        }
                    }, 1000);
                }
            } else {
                throw new Error(result.error || 'An unknown error occurred');
            }
        } catch (error) {
            await Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message
            });
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    });
});

class ProviderChainEditor {
    constructor() {
        this.container = document.getElementById('providerChain');
        this.hiddenInput = document.getElementById('providers');
        this.addBtn = document.getElementById('addProviderButton');
        this.providers = (window.__initialProviders && window.__initialProviders.length)
            ? window.__initialProviders.slice()
            : [this.defaultProvider()];
        this.health = window.__initialHealth || {};

        this.addBtn.addEventListener('click', () => {
            this.providers.push({
                id: `provider-${this.providers.length + 1}`,
                name: `Provider ${this.providers.length + 1}`,
                type: 'custom',
                priority: this.providers.length + 1,
                enabled: true,
                model: '',
                baseUrl: '',
                apiKey: '',
                endpoint: '',
                deploymentName: '',
                apiVersion: '2023-05-15'
            });
            this.render();
        });

        this.render();
    }

    defaultProvider() {
        const legacy = (window.__initialProviders && window.__initialProviders[0]) || null;
        return legacy || {
            id: 'primary',
            name: 'Primary',
            type: 'openai',
            priority: 1,
            enabled: true,
            model: 'gpt-4o-mini',
            apiKey: '',
            baseUrl: '',
            endpoint: '',
            deploymentName: '',
            apiVersion: '2023-05-15'
        };
    }

    syncHidden() {
        this.hiddenInput.value = JSON.stringify(this.providers);
    }

    statusBadge(provider) {
        const h = this.health[provider.id];
        if (!h) return '<span class="text-xs text-gray-500">not tested</span>';
        if (h.ok) return '<span class="text-xs text-green-600"><i class="fas fa-check-circle"></i> ok</span>';
        return `<span class="text-xs text-red-600" title="${(h.lastError || '').replace(/"/g, '&quot;')}"><i class="fas fa-exclamation-circle"></i> failed</span>`;
    }

    fieldsFor(provider) {
        const rows = [];
        const type = provider.type;
        if (type === 'openai') {
            rows.push({ key: 'apiKey', label: 'API Key', secret: true, required: true });
        } else if (type === 'ollama') {
            rows.push({ key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'http://localhost:11434' });
        } else if (type === 'custom') {
            rows.push({ key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'https://api.example.com/v1' });
            rows.push({ key: 'apiKey', label: 'API Key', secret: true, required: true });
        } else if (type === 'azure') {
            rows.push({ key: 'endpoint', label: 'Endpoint', required: true });
            rows.push({ key: 'apiKey', label: 'API Key', secret: true, required: true });
            rows.push({ key: 'deploymentName', label: 'Deployment', required: true });
            rows.push({ key: 'apiVersion', label: 'API Version', required: false });
        }
        return rows;
    }

    render() {
        this.container.innerHTML = '';
        this.providers.forEach((provider, index) => {
            const card = document.createElement('div');
            card.className = 'border border-gray-300 dark:border-gray-600 rounded-lg p-3 space-y-2 bg-white dark:bg-gray-800';
            card.dataset.index = index;

            const header = document.createElement('div');
            header.className = 'flex items-center gap-2 flex-wrap';
            header.innerHTML = `
                <span class="font-mono text-sm font-bold w-6">#${index + 1}</span>
                <input type="text" data-field="name" value="${(provider.name || '').replace(/"/g, '&quot;')}"
                       class="flex-1 min-w-[8rem] px-2 py-1 border border-gray-300 dark:border-gray-600 rounded" placeholder="Name">
                <select data-field="type" class="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded">
                    ${['openai', 'ollama', 'custom', 'azure'].map(t =>
                        `<option value="${t}" ${provider.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
                <input type="number" data-field="priority" min="1" value="${provider.priority || index + 1}"
                       class="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded" title="Priority (1 = tried first)">
                <label class="flex items-center gap-1 text-sm">
                    <input type="checkbox" data-field="enabled" ${provider.enabled !== false ? 'checked' : ''}> enabled
                </label>
                ${this.statusBadge(provider)}
                <button type="button" class="px-2 py-1 text-sm rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300" data-action="test" title="Test this provider">
                    <i class="fas fa-bolt"></i> test
                </button>
                <button type="button" class="px-2 py-1 text-sm rounded text-red-600 hover:bg-red-50" data-action="remove" title="Remove provider">
                    <i class="fas fa-trash"></i>
                </button>
            `;

            const modelRow = document.createElement('div');
            modelRow.className = 'flex items-center gap-2 flex-wrap';
            modelRow.innerHTML = `
                <label class="text-xs font-medium w-24">Model</label>
                <input type="text" data-field="model" value="${(provider.model || '').replace(/"/g, '&quot;')}"
                       class="flex-1 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded" placeholder="model name">
            `;

            card.appendChild(header);
            card.appendChild(modelRow);

            for (const field of this.fieldsFor(provider)) {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-2 flex-wrap';
                row.innerHTML = `
                    <label class="text-xs font-medium w-24">${field.label}</label>
                    <input type="${field.secret ? 'password' : 'text'}" data-field="${field.key}"
                           value="${(provider[field.key] || '').replace(/"/g, '&quot;')}"
                           class="flex-1 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded"
                           placeholder="${field.placeholder || ''}" ${field.required ? 'required' : ''}>
                `;
                card.appendChild(row);
            }

            card.addEventListener('input', (e) => {
                const key = e.target.dataset.field;
                if (!key) return;
                provider[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                this.syncHidden();
            });
            card.addEventListener('change', (e) => {
                const key = e.target.dataset.field;
                if (key === 'type') { this.render(); }
            });
            card.querySelector('[data-action="remove"]').addEventListener('click', () => {
                this.providers.splice(index, 1);
                this.syncHidden();
                this.render();
            });
            card.querySelector('[data-action="test"]').addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    const res = await fetch('/api/providers/test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(provider)
                    });
                    const result = await res.json();
                    if (result.ok) {
                        btn.innerHTML = '<i class="fas fa-check-circle text-green-600"></i>';
                    } else {
                        btn.innerHTML = `<i class="fas fa-exclamation-circle text-red-600"></i>`;
                        btn.title = result.error || 'failed';
                    }
                } catch (error) {
                    btn.innerHTML = '<i class="fas fa-exclamation-circle text-red-600"></i>';
                    btn.title = error.message;
                } finally {
                    btn.disabled = false;
                }
            });

            this.container.appendChild(card);
        });

        // Sort view by priority so the list reads top-down as the chain.
        const sorted = [...this.providers].sort((a, b) => (a.priority || 99) - (b.priority || 99));
        this.container.querySelectorAll('.font-mono').forEach((el, i) => {
            const provider = sorted[i];
            el.textContent = `#${provider.priority || i + 1}`;
        });
        this.syncHidden();
    }
}

class URLValidator {
    constructor() {
        this.urlInput = document.getElementById('paperlessUrl');
        this.isShowingError = false;
        this.initialize();
    }

    initialize() {
        this.urlInput.addEventListener('blur', () => this.validateURL());
    }

    async validateURL() {
        if (this.isShowingError) return;

        try {
            if (!this.urlInput.value) return;
            const url = new URL(this.urlInput.value);

            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error('The URL must start with http:// or https://');
            }

            // Prüfe auf zusätzliche Pfade oder Parameter
            if (url.pathname !== '/' || url.search || url.hash) {
                throw new Error('The URL must not contain any paths, parameters, or trailing slashes after the port.');
            }

            // Automatische Formatierung der URL
            const formattedUrl = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
            if (this.urlInput.value !== formattedUrl) {
                this.urlInput.value = formattedUrl;
            }

        } catch (error) {
            this.isShowingError = true;
            const result = await Swal.fire({
                icon: 'warning',
                title: 'Invalid URL',
                text: error.message,
                showCancelButton: true,
                confirmButtonText: 'Confirm anyway',
                cancelButtonText: 'Fix it',
                customClass: {
                    container: 'z-50'
                }
            });

            this.isShowingError = false;
            if (result.isDismissed) {
                this.sanitizeURL();
            }
        }
    }

    sanitizeURL() {
        try {
            if (!this.urlInput.value) return;
            const url = new URL(this.urlInput.value);
            this.urlInput.value = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid URL',
                text: 'Please enter a valid URL. ( http[s]://your-paperless-instance:8000 )',
                customClass: {
                    container: 'z-50'
                }
            });
        }
    }
}

// Tooltip System
class TooltipManager {
    constructor() {
        this.initialize();
    }

    getTooltipPlacement() {
        return window.innerWidth < 768 ? 'bottom' : 'right';
    }

    initialize() {
        this.tooltipInstance = tippy('#urlHelp', {
            content: this.getTooltipContent(),
            allowHTML: true,
            placement: this.getTooltipPlacement(),
            interactive: true,
            theme: 'custom',
            maxWidth: 450,
            touch: 'hold',
            trigger: 'mouseenter click',
            zIndex: 40,
        });

        window.addEventListener('resize', () => {
            this.tooltipInstance[0].setProps({ placement: this.getTooltipPlacement() });
        });
    }

    getTooltipContent() {
        return `
            <div class="p-4 space-y-4">
                <h3 class="text-lg font-bold">API URL Configuration</h3>
                
                <div class="space-y-2">
                    <p>The URL should follow this format:</p>
                    <code class="block p-2 bg-gray-100 dark:bg-gray-800 rounded">
                        http://your-host:8000
                    </code>
                </div>
                
                <div class="space-y-2">
                    <p class="font-semibold">Important Notes:</p>
                    <ul class="list-disc pl-4 space-y-1">
                        <li>Must start with <u>http://</u> or <u>https://</u></li>
                        <li>Contains <strong>host/IP</strong> and optionally a <strong>port</strong></li>
                        <li>No additional paths or parameters</li>
                    </ul>
                </div>

                <div class="space-y-2">
                    <p class="font-semibold">Docker Network Configuration:</p>
                    <ul class="list-disc pl-4 space-y-1">
                        <li>Using <strong>localhost</strong> or <strong>127.0.0.1</strong> won't work in Docker bridge mode</li>
                        <li>Use your machine's local IP (e.g., <code>192.168.1.x</code>) instead</li>
                        <li>Or use the Docker container name if both services are in the same network</li>
                    </ul>
                </div>

                <div class="space-y-2">
                    <p class="font-semibold">Examples:</p>
                    <ul class="list-none space-y-1">
                        <li>🔸 Local IP: <code>http://192.168.1.100:8000</code></li>
                        <li>🔸 Container: <code>http://paperless-ngx:8000</code></li>
                        <li>🔸 Remote: <code>http://paperless.domain.com</code></li>
                    </ul>
                </div>

                <p class="text-sm italic mt-4">The /api endpoint will be added automatically.</p>
            </div>
        `;
    }
}

// Initialize all components
document.addEventListener('DOMContentLoaded', () => {
    const urlValidator = new URLValidator();
    const tooltipManager = new TooltipManager();
    if (document.getElementById('providerChain')) {
        new ProviderChainEditor();
    }
});


// Custom Fields Management
document.addEventListener('DOMContentLoaded', function() {
    // External API settings toggle
    const externalApiEnabled = document.getElementById('externalApiEnabled');
    const externalApiSettings = document.getElementById('externalApiSettings');
    
    if (externalApiEnabled && externalApiSettings) {
        externalApiEnabled.addEventListener('change', function() {
            if (this.checked) {
                externalApiSettings.classList.remove('hidden');
            } else {
                externalApiSettings.classList.add('hidden');
            }
        });
    }
    
    const fieldsList = document.getElementById('customFieldsList');
    if (fieldsList) {
        // Initialize Sortable
        new Sortable(fieldsList, {
            animation: 150,
            handle: '.cursor-move',
            onEnd: updateCustomFieldsJson
        });

        // Add initial theme classes based on current theme
        const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDarkMode) {
            updateThemeClasses(true);
        }
    }

    // Initialize type selection
    const typeSelect = document.getElementById('newFieldType');
    if (typeSelect) {
        typeSelect.addEventListener('change', toggleCurrencySelect);
        // Initial currency select visibility
        toggleCurrencySelect();
    }

    // Initialize name input
    const nameInput = document.getElementById('newFieldName');
    if (nameInput) {
        nameInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addCustomField();
            }
        });
    }

    // Observer for theme changes
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.attributeName === 'data-theme') {
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                updateThemeClasses(isDark);
            }
        });
    });

    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
    });
});

function updateThemeClasses(isDark) {
    // Update custom field items
    const items = document.querySelectorAll('.custom-field-item');
    items.forEach(item => {
        // Background and border
        item.classList.toggle('bg-white', !isDark);
        item.classList.toggle('bg-gray-800', isDark);
        item.classList.toggle('border-gray-200', !isDark);
        item.classList.toggle('border-gray-700', isDark);

        // Text colors
        const title = item.querySelector('p.font-medium');
        if (title) {
            title.classList.toggle('text-gray-900', !isDark);
            title.classList.toggle('text-gray-100', isDark);
        }

        const subtitle = item.querySelector('p.text-sm');
        if (subtitle) {
            subtitle.classList.toggle('text-gray-500', !isDark);
            subtitle.classList.toggle('text-gray-400', isDark);
        }
    });

    // Update form inputs and selects
    const inputs = document.querySelectorAll('input:not([type="hidden"]), select');
    inputs.forEach(input => {
        input.classList.toggle('bg-white', !isDark);
        input.classList.toggle('bg-gray-800', isDark);
        input.classList.toggle('text-gray-900', !isDark);
        input.classList.toggle('text-gray-100', isDark);
        input.classList.toggle('border-gray-300', !isDark);
        input.classList.toggle('border-gray-600', isDark);
    });
}

function toggleCurrencySelect() {
    const fieldType = document.getElementById('newFieldType').value;
    const currencySelect = document.getElementById('currencyCode');
    
    if (fieldType === 'monetary') {
        currencySelect.classList.remove('hidden');
    } else {
        currencySelect.classList.add('hidden');
    }
}

function updateCustomFieldsJson() {
    const fieldItems = document.querySelectorAll('.custom-field-item');
    const fields = Array.from(fieldItems).map(item => {
        const fieldName = item.querySelector('p.font-medium').textContent;
        const typeText = item.querySelector('p.text-sm').textContent;
        const data_type = typeText.split('Type: ')[1].split(' ')[0];
        const currency = typeText.includes('(') ? typeText.split('(')[1].split(')')[0] : null;
        
        const field = {
            value: fieldName,
            data_type: data_type
        };
        
        if (currency) {
            field.currency = currency;
        }
        
        return field;
    });
    
    document.getElementById('customFieldsJson').value = JSON.stringify({
        custom_fields: fields
    });
}

function createFieldElement(fieldName, data_type, currency = null) {
    const div = document.createElement('div');
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    
    div.className = `custom-field-item flex items-center gap-2 p-3 rounded-lg border hover:border-blue-500 transition-colors ${
        isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
    }`;
    
    let typeDisplay = `Type: ${data_type}`;
    if (data_type === 'monetary' && currency) {
        typeDisplay += ` (${currency})`;
    }
    
    div.innerHTML = `
        <div class="cursor-move text-gray-400">
            <i class="fas fa-grip-vertical"></i>
        </div>
        <div class="flex-1">
            <p class="font-medium ${isDark ? 'text-gray-100' : 'text-gray-900'}">${fieldName}</p>
            <p class="text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}">${typeDisplay}</p>
        </div>
        <button type="button" 
                onclick="removeCustomField(this)"
                class="text-gray-400 hover:text-red-500 transition-colors">
            <i class="fas fa-trash"></i>
        </button>
    `;
    
    return div;
}

function addCustomField() {
    const nameInput = document.getElementById('newFieldName');
    const typeSelect = document.getElementById('newFieldType');
    const currencySelect = document.getElementById('currencyCode');
    const fieldsList = document.getElementById('customFieldsList');
    
    const fieldName = nameInput.value.trim();
    const data_type = typeSelect.value;
    const currency = data_type === 'monetary' ? currencySelect.value : null;
    
    if (!fieldName) {
        Swal.fire({
            icon: 'warning',
            title: 'Invalid Field Name',
            text: 'Please enter a field name'
        });
        return;
    }
    
    // Check for duplicates
    const existingFields = Array.from(fieldsList.querySelectorAll('p.font-medium'))
        .map(p => p.textContent);
    
    if (existingFields.includes(fieldName)) {
        Swal.fire({
            icon: 'warning',
            title: 'Duplicate Field',
            text: 'A field with this name already exists'
        });
        return;
    }
    
    const fieldElement = createFieldElement(fieldName, data_type, currency);
    fieldsList.appendChild(fieldElement);
    
    // Reset inputs
    nameInput.value = '';
    
    // Update hidden input
    updateCustomFieldsJson();
}

function removeCustomField(button) {
    const fieldItem = button.closest('.custom-field-item');
    Swal.fire({
        title: 'Delete Field?',
        text: 'Are you sure you want to delete this custom field?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Yes, delete it!'
    }).then((result) => {
        if (result.isConfirmed) {
            fieldItem.remove();
            updateCustomFieldsJson();
        }
    });
}
