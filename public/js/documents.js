// Theme Management
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }

    initialize() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        this.themeToggle?.addEventListener('click', () => this.toggleTheme());
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        const icon = this.themeToggle.querySelector('i');
        if (icon) {
            icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
        }
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        this.setTheme(currentTheme === 'light' ? 'dark' : 'light');
    }
}

// Titles, tag and correspondent names come from Paperless (and the AI), so
// everything rendered into HTML is escaped.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
}

function safeColor(value, fallback) {
    return /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : fallback;
}

// DataTables column index -> Paperless ordering field (null = not sortable).
const ORDERING_BY_COLUMN = { 1: 'id', 2: 'title', 4: 'correspondent__name', 5: 'created' };

class DocumentsPage {
    constructor() {
        // Explicit selection: id -> title, kept across pages and filter changes.
        this.selected = new Map();
        // "All matching" selection: the filter snapshot it was made with.
        this.allMatching = null;
        this.totalMatching = 0;
        this.pageRows = [];
        this.runWasActive = false;

        this.tagSelect = new TomSelect('#tagFilter', { plugins: ['remove_button'], maxOptions: null });
        this.correspondentSelect = new TomSelect('#correspondentFilter', { plugins: ['remove_button'], maxOptions: null });

        this.table = this.initializeTable();
        this.initializeFilters();
        this.initializeSelection();
        this.initializeReprocessModal();
        this.pollRunStatus();
    }

    currentFilter() {
        return {
            tags: this.tagSelect.getValue().map(Number),
            tagMode: document.getElementById('tagMode').value,
            correspondents: this.correspondentSelect.getValue().map(Number),
            search: this.table ? this.table.search() : ''
        };
    }

    initializeTable() {
        return $('#documentsTable').DataTable({
            serverSide: true,
            processing: true,
            searchDelay: 400,
            pageLength: 25,
            lengthMenu: [10, 25, 50, 100],
            order: [[5, 'desc']],
            ajax: (data, callback) => this.loadPage(data, callback),
            columns: [
                {
                    data: 'id',
                    orderable: false,
                    width: '32px',
                    render: (id) => `<input type="checkbox" class="doc-select rounded" value="${id}"
                        ${this.isSelected(id) ? 'checked' : ''} ${this.allMatching ? 'disabled' : ''}>`
                },
                { data: 'id', width: '60px' },
                {
                    data: 'title',
                    render: (title) => `<span class="font-medium">${escapeHtml(title)}</span>`
                },
                {
                    data: 'tags',
                    orderable: false,
                    render: (tags) => tags.length
                        ? tags.map(tag => `<span class="tag-chip" style="background:${safeColor(tag.color, '#dbeafe')};color:${safeColor(tag.text_color, '#1e3a8a')}">${escapeHtml(tag.name)}</span>`).join('')
                        : '<span class="text-gray-400 text-sm">No tags</span>'
                },
                {
                    data: 'correspondent',
                    render: (corr) => corr ? escapeHtml(corr.name) : '<span class="text-gray-400 text-sm">None</span>'
                },
                {
                    data: 'created',
                    className: 'whitespace-nowrap',
                    render: (created) => created ? escapeHtml(new Date(created).toLocaleDateString()) : ''
                },
                {
                    data: 'processedAt',
                    orderable: false,
                    className: 'whitespace-nowrap',
                    render: (processedAt) => {
                        if (!processedAt) return '<span class="text-gray-400 text-sm">Not processed</span>';
                        const date = new Date(processedAt);
                        return `<span title="${escapeHtml(date.toISOString())}"><i class="fas fa-check text-green-600 mr-1"></i>${escapeHtml(date.toLocaleString())}</span>`;
                    }
                },
                {
                    data: 'link',
                    orderable: false,
                    render: (link) => `<a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors" title="Open in Paperless-ngx"><i class="fa-solid fa-eye"></i></a>`
                }
            ],
            createdRow: (row, data) => {
                if (this.isSelected(data.id)) row.classList.add('row-selected');
            },
            drawCallback: () => this.updateSelectionUi(),
            dom: '<"flex flex-col sm:flex-row justify-between items-center mb-4"<"flex-1"f><"flex-none"l>>rtip',
            language: {
                search: 'Search title and content:',
                lengthMenu: 'Show _MENU_ documents',
                info: 'Showing _START_ to _END_ of _TOTAL_ documents',
                infoEmpty: 'No documents match',
                processing: 'Loading documents from Paperless-ngx…'
            }
        });
    }

    async loadPage(data, callback) {
        const order = data.order && data.order[0];
        const field = order && ORDERING_BY_COLUMN[order.column];
        const params = new URLSearchParams({
            page: String(Math.floor(data.start / data.length) + 1),
            pageSize: String(data.length),
            ordering: field ? (order.dir === 'desc' ? `-${field}` : field) : '-created',
            tags: this.tagSelect.getValue().join(','),
            tagMode: document.getElementById('tagMode').value,
            correspondents: this.correspondentSelect.getValue().join(','),
            search: data.search.value || ''
        });

        try {
            const response = await fetch(`/api/documents?${params}`);
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Failed to load documents');
            this.pageRows = result.results;
            this.totalMatching = result.count;
            callback({ draw: data.draw, recordsTotal: result.count, recordsFiltered: result.count, data: result.results });
        } catch (error) {
            console.error('Loading documents failed:', error);
            this.pageRows = [];
            this.totalMatching = 0;
            callback({ draw: data.draw, recordsTotal: 0, recordsFiltered: 0, data: [] });
            this.showRunBanner(error.message, 'error');
        }
    }

    initializeFilters() {
        const reload = () => {
            // An "all matching" selection was made for the old filter.
            if (this.allMatching) this.allMatching = null;
            this.table.ajax.reload();
        };
        this.tagSelect.on('change', reload);
        this.correspondentSelect.on('change', reload);
        document.getElementById('tagMode').addEventListener('change', reload);
        this.table.on('search.dt', () => {
            if (this.allMatching && this.allMatching.search !== this.table.search()) this.allMatching = null;
        });
        document.getElementById('clearFilters').addEventListener('click', () => {
            this.tagSelect.clear(true);
            this.correspondentSelect.clear(true);
            document.getElementById('tagMode').value = 'any';
            this.table.search('');
            reload();
        });
    }

    // --- Selection ----------------------------------------------------------

    isSelected(id) {
        return this.allMatching !== null || this.selected.has(id);
    }

    selectionCount() {
        return this.allMatching ? this.totalMatching : this.selected.size;
    }

    initializeSelection() {
        $('#documentsTable tbody').on('change', '.doc-select', (event) => {
            const id = Number(event.target.value);
            const row = this.pageRows.find(doc => doc.id === id);
            if (event.target.checked) this.selected.set(id, row ? row.title : String(id));
            else this.selected.delete(id);
            event.target.closest('tr').classList.toggle('row-selected', event.target.checked);
            this.updateSelectionUi();
        });

        document.getElementById('selectPage').addEventListener('change', (event) => {
            for (const doc of this.pageRows) {
                if (event.target.checked) this.selected.set(doc.id, doc.title);
                else this.selected.delete(doc.id);
            }
            this.table.rows().invalidate('data').draw(false);
        });

        document.getElementById('selectAllMatching').addEventListener('click', () => {
            if (this.allMatching) {
                this.clearSelection();
                return;
            }
            this.allMatching = this.currentFilter();
            this.table.rows().invalidate('data').draw(false);
        });

        document.getElementById('clearSelection').addEventListener('click', () => this.clearSelection());
    }

    clearSelection() {
        this.selected.clear();
        this.allMatching = null;
        this.table.rows().invalidate('data').draw(false);
    }

    updateSelectionUi() {
        const count = this.selectionCount();
        const pageIds = this.pageRows.map(doc => doc.id);
        const pageAllSelected = pageIds.length > 0 && pageIds.every(id => this.isSelected(id));
        const pageSomeSelected = pageIds.some(id => this.isSelected(id));

        const selectPage = document.getElementById('selectPage');
        selectPage.checked = pageAllSelected;
        selectPage.indeterminate = pageSomeSelected && !pageAllSelected;
        selectPage.disabled = this.allMatching !== null;

        document.getElementById('selectionCount').textContent = count === 0
            ? 'No documents selected'
            : `${count} document${count === 1 ? '' : 's'} selected`;

        // Gmail-style offer to extend a full page selection to every match.
        const hint = document.getElementById('selectAllMatchingHint');
        const hintButton = document.getElementById('selectAllMatching');
        const hintText = document.getElementById('pageSelectedText');
        if (this.allMatching) {
            hint.classList.remove('hidden');
            hintText.textContent = 'All documents matching the filters are selected.';
            hintButton.textContent = 'Clear selection';
        } else if (pageAllSelected && this.totalMatching > pageIds.length && this.selected.size < this.totalMatching) {
            hint.classList.remove('hidden');
            hintText.textContent = `All ${pageIds.length} on this page are selected.`;
            hintButton.textContent = `Select all ${this.totalMatching} matching documents`;
        } else {
            hint.classList.add('hidden');
        }

        document.getElementById('clearSelection').disabled = count === 0;
        document.getElementById('reprocessSelected').disabled = count === 0 || this.runWasActive;
    }

    // --- Reprocess ----------------------------------------------------------

    initializeReprocessModal() {
        const modal = document.getElementById('reprocessModal');
        const hide = () => {
            modal.classList.remove('show');
            modal.classList.add('hidden');
        };

        document.getElementById('reprocessSelected').addEventListener('click', () => {
            const count = this.selectionCount();
            document.getElementById('reprocessCountText').textContent =
                `${count} document${count === 1 ? '' : 's'}`;
            document.getElementById('reprocessError').classList.add('hidden');
            modal.classList.remove('hidden');
            modal.classList.add('show');
        });
        modal.querySelector('.modal-overlay').addEventListener('click', hide);
        modal.querySelector('.modal-close').addEventListener('click', hide);
        document.getElementById('cancelReprocess').addEventListener('click', hide);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && modal.classList.contains('show')) hide();
        });

        document.getElementById('confirmReprocess').addEventListener('click', async (event) => {
            const button = event.currentTarget;
            if (button.disabled) return;

            const fields = [...document.querySelectorAll('.reprocess-field:checked')].map(input => input.value);
            const errorText = document.getElementById('reprocessError');
            if (!fields.length) {
                errorText.textContent = 'Choose at least one field to update.';
                errorText.classList.remove('hidden');
                return;
            }

            const body = this.allMatching
                ? { filter: this.allMatching, fields }
                : { ids: [...this.selected.keys()], fields };

            button.disabled = true;
            try {
                const response = await fetch('/api/documents/reprocess', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || 'Reprocess failed');

                hide();
                this.clearSelection();
                this.showRunBanner(`Reprocess started for ${result.totalDocuments} documents…`, 'running');
                // A short run can end before the first poll; this still makes the
                // poll report the result and refresh the table.
                this.runWasActive = true;
                this.pollRunStatus();
            } catch (error) {
                errorText.textContent = error.message;
                errorText.classList.remove('hidden');
            } finally {
                button.disabled = false;
            }
        });
    }

    showRunBanner(text, state) {
        const banner = document.getElementById('runBanner');
        const icon = document.getElementById('runBannerIcon');
        banner.classList.remove('hidden', 'border-blue-300', 'bg-blue-50', 'text-blue-900',
            'border-green-300', 'bg-green-50', 'text-green-900', 'border-red-300', 'bg-red-50', 'text-red-900');
        const colors = {
            running: ['border-blue-300', 'bg-blue-50', 'text-blue-900'],
            done: ['border-green-300', 'bg-green-50', 'text-green-900'],
            error: ['border-red-300', 'bg-red-50', 'text-red-900']
        }[state];
        banner.classList.add(...colors);
        icon.className = state === 'running' ? 'fas fa-spinner fa-spin mr-2'
            : state === 'done' ? 'fas fa-check mr-2' : 'fas fa-exclamation-circle mr-2';
        document.getElementById('runBannerText').textContent = text;
    }

    // Follow the active run (started here, from the dashboard or by the cron)
    // and refresh the table once it ends, so new titles and tags show.
    async pollRunStatus() {
        clearTimeout(this.pollTimer);
        try {
            const response = await fetch('/api/processing-status');
            const status = await response.json();
            const run = status.run || {};
            const active = !!run.running;

            if (active && run.current) {
                const doc = status.currentlyProcessing;
                const done = run.current.processed + run.current.skipped + run.current.failed;
                this.showRunBanner(
                    `${run.current.kind === 'reprocess' ? 'Reprocessing' : 'Scanning'}: ${done} of ${run.current.total} done` +
                    ` (${run.current.processed} updated, ${run.current.skipped} skipped, ${run.current.failed} failed)` +
                    (doc ? ` — now: ${doc.title}` : ''),
                    'running'
                );
            } else if (active) {
                this.showRunBanner('Paperless-AI is processing documents…', 'running');
            } else if (this.runWasActive && run.last) {
                const last = run.last;
                this.showRunBanner(
                    `${last.kind === 'reprocess' ? 'Reprocess' : 'Scan'} finished: ${last.processed} updated, ` +
                    `${last.skipped} skipped, ${last.failed} failed of ${last.total}.`,
                    last.failed ? 'error' : 'done'
                );
                this.table.ajax.reload(null, false);
            }

            this.runWasActive = active;
            this.updateSelectionUi();
            if (active) this.pollTimer = setTimeout(() => this.pollRunStatus(), 2000);
        } catch (error) {
            console.error('Failed to read processing status:', error);
            this.pollTimer = setTimeout(() => this.pollRunStatus(), 5000);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.documentsPage = new DocumentsPage();
});
