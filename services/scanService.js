/**
 * Document processing pipeline, shared by the cron scan and the HTTP routes.
 *
 * server.js and routes/setup.js each carried their own copy of processDocument /
 * buildUpdateData / saveDocumentChanges. The copies had drifted apart: the route
 * version honoured RESTRICT_TO_EXISTING_TAGS/CORRESPONDENTS, the cron version did
 * not, so the same document could be classified differently depending on which
 * path processed it. This module is now the single implementation both paths use.
 */
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const documentModel = require('../models/document');
const AIServiceFactory = require('./aiServiceFactory');
const taskLock = require('./taskLock');

// Counters of the most recent completed run, exposed for the UI to report after
// a run finishes (processing-status only shows the currently active document).
let lastRun = null;
let currentRun = null;

/**
 * Analyse one document. Returns null when the document is skipped (already
 * processed, not editable by the Paperless-AI user, or no usable content).
 *
 * opts.force re-processes documents that already have a processed_documents row —
 * used by the reprocess-all run. Permission and content checks still apply, so
 * documents the AI user cannot edit are never touched.
 */
async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId, customPrompt = null, opts = {}) {
  if (!opts.force) {
    const isProcessed = await documentModel.isDocumentProcessed(doc.id);
    if (isProcessed) return null;
  }

  // Check if the document can be edited
  const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
  if (!documentEditable) {
    console.log(`[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`);
    console.log(`[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`);
    return null;
  } else {
    console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
  }

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id)
  ]);

  // (Was `!content.length >= 10`, which is never true, so near-empty documents
  // were sent to the AI.)
  if (!content || content.length < 10) {
    console.log(`[DEBUG] Document ${doc.id} has no content, skipping analysis`);
    return null;
  }

  // Mark the document as in progress only now that it will be analysed: the
  // dashboard shows any recent status row as "currently processing", so a
  // skipped document must not leave one behind.
  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  // Prepare options for AI service
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes'
  };

  // Get external API data if enabled
  if (config.externalApiConfig.enabled === 'yes') {
    try {
      const externalApiService = require('./externalApiService');
      const externalData = await externalApiService.fetchData();
      if (externalData) {
        options.externalApiData = externalData;
        console.log('[DEBUG] Retrieved external API data for prompt enrichment');
      }
    } catch (error) {
      console.error('[ERROR] Failed to fetch external API data:', error.message);
    }
  }

  let analysis;
  const runAnalysis = (service) => {
    return customPrompt
      ? service.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, customPrompt, options)
      : service.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, null, options);
  };

  try {
    analysis = await AIServiceFactory.execute(runAnalysis);
  } catch (error) {
    console.error(`[ERROR] Document analysis failed: ${error.message}`);
    analysis = { error: error.message };
  }

  console.log('Response from AI service:', analysis);
  if (analysis.error) {
    await documentModel.setProcessingStatus(doc.id, doc.title, 'failed');
    throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
  }

  await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
  return { analysis, originalData };
}

// Fields a reprocess run can update (documents page).
const REPROCESS_FIELDS = ['title', 'tags', 'correspondent'];

/**
 * Reprocess of chosen fields: apply exactly those fields from the analysis,
 * whatever the activate* settings say (the user picked them explicitly), and
 * leave everything else (date, document type, custom fields) untouched.
 */
async function buildFieldUpdate(analysis, fields) {
  const updateData = {};
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes'
  };

  if (fields.includes('title') && analysis.document.title) {
    updateData.title = analysis.document.title;
  }

  if (fields.includes('tags')) {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags || [], options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  }

  if (fields.includes('correspondent') && analysis.document.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent, options);
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

  return updateData;
}

/**
 * opts.fields (reprocess from the documents page) limits the update to those
 * fields; otherwise the activate* settings decide, as for a regular scan.
 */
async function buildUpdateData(analysis, doc, opts = {}) {
  if (opts.fields) return buildFieldUpdate(analysis, opts.fields);

  const updateData = {};

  // Create options object with restriction settings
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes' ? true : false,
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes' ? true : false
  };

  console.log(`[DEBUG] Building update data with restrictions: tags=${options.restrictToExistingTags}, correspondents=${options.restrictToExistingCorrespondents}`);

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags, options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (config.limitFunctions?.activateTagging === 'no' && config.addAIProcessedTag === 'yes') {
    // Add AI processed tags to the document (processTags function awaits a tags array)
    // get tags from .env file and split them by comma and make an array
    console.log('[DEBUG] Tagging is deactivated but AI processed tag will be added');
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(tags, options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
    console.log('[DEBUG] Tagging is deactivated');
  }

  // Only process title if title generation is activated
  if (config.limitFunctions?.activateTitle !== 'no') {
    updateData.title = analysis.document.title || doc.title;
  }

  // Add created date regardless of settings as it's a core field
  updateData.created = analysis.document.document_date || doc.created;

  // Only process document type if document type classification is activated
  if (config.limitFunctions?.activateDocumentType !== 'no' && analysis.document.document_type) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type);
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type:`, error);
    }
  }

  // Only process custom fields if custom fields detection is activated
  if (config.limitFunctions?.activateCustomFields !== 'no' && analysis.document.custom_fields) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const key in customFields) {
      const customField = customFields[key];

      if (!customField.field_name || !customField.value?.trim()) {
        console.log(`[DEBUG] Skipping empty/invalid custom field`);
        continue;
      }

      const fieldDetails = await paperlessService.findExistingCustomField(customField.field_name);
      if (fieldDetails?.id) {
        processedFields.push({
          field: fieldDetails.id,
          value: customField.value.trim()
        });
        processedFieldIds.add(fieldDetails.id);
      }
    }

    // Then add any existing fields that weren't updated
    for (const existingField of existingFields) {
      if (!processedFieldIds.has(existingField.field)) {
        processedFields.push(existingField);
      }
    }

    if (processedFields.length > 0) {
      updateData.custom_fields = processedFields;
    }
  }

  // Only process correspondent if correspondent detection is activated
  if (config.limitFunctions?.activateCorrespondents !== 'no' && analysis.document.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent, options);
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

  // Always include language if provided as it's a core field
  if (analysis.document.language) {
    updateData.language = analysis.document.language;
  }

  return updateData;
}

function parseTagIds(json) {
  try {
    const ids = JSON.parse(json || '[]');
    return Array.isArray(ids) ? ids.map(Number) : [];
  } catch (error) {
    return [];
  }
}

/**
 * Tags the previous AI run added: the tags in its history row that the
 * document did not have originally. A reprocess replaces these with the new
 * AI tags; original tags and tags added by hand stay on the document.
 */
async function previousAiTagIds(docId) {
  const [history, original] = await Promise.all([
    documentModel.getHistory(docId),
    documentModel.getOriginalData(docId)
  ]);
  const originalTags = new Set(parseTagIds(original && original.tags));
  return parseTagIds(history && history.tags).filter(id => !originalTags.has(id));
}

async function saveDocumentChanges(docId, updateData, analysis, originalData, opts = {}) {
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;

  // Regular scans only add tags and keep an existing correspondent. A
  // reprocess (opts.force) that writes tags replaces the tags the previous AI
  // run added; a field reprocess also replaces the correspondent, and keeps the
  // history row's values for fields it did not touch.
  const replacesTags = opts.fields ? opts.fields.includes('tags') : Boolean(opts.force && updateData.tags);
  const removeTagIds = replacesTags ? (opts.previousAiTags || await previousAiTagIds(docId)) : [];
  const updateOptions = {
    overwriteCorrespondent: Boolean(opts.fields && opts.fields.includes('correspondent')),
    removeTagIds
  };
  let historyTags = updateData.tags;
  let historyCorrespondent = analysis.document.correspondent;
  if (opts.fields) {
    const previous = await documentModel.getHistory(docId);
    if (!opts.fields.includes('tags')) historyTags = parseTagIds(previous && previous.tags);
    if (!opts.fields.includes('correspondent')) historyCorrespondent = previous ? previous.correspondent : null;
  }
  const title = updateData.title || originalTitle;

  // The original snapshot is only written when none exists (first processing,
  // or after dropHistory). Leave out the AI tags being replaced, so a snapshot
  // taken after the history was dropped still tells them apart from the
  // document's own tags.
  const snapshotTags = (originalTags || []).filter(id => !removeTagIds.includes(id));

  await Promise.all([
    documentModel.saveOriginalData(docId, snapshotTags, originalCorrespondent, originalTitle),
    paperlessService.updateDocument(docId, { ...updateData }, updateOptions),
    documentModel.addProcessedDocument(docId, title),
    // Ollama and some providers report no token usage (metrics: null), so only
    // record metrics when the analysis actually carries them.
    analysis.metrics
      ? documentModel.addOpenAIMetrics(
        docId,
        analysis.metrics.promptTokens,
        analysis.metrics.completionTokens,
        analysis.metrics.totalTokens
      )
      : Promise.resolve(false),
    documentModel.addToHistory(docId, historyTags, title, historyCorrespondent)
  ]);
}

/**
 * Fetch the reference lists the pipeline needs (tag, correspondent and
 * document type names, own user id). Every caller of processDocument uses
 * this, so they all pass the same shapes (names, not Paperless objects).
 */
async function collectContext() {
  const [existingTags, ownUserId, existingCorrespondents, existingDocumentTypes] = await Promise.all([
    paperlessService.getTags(),
    paperlessService.getOwnUserID(),
    paperlessService.listCorrespondentsNames(),
    paperlessService.listDocumentTypesNames()
  ]);

  // Creation order (by id), not alphabetical: a newly created entry lands at
  // the end of its list, so the prompt before it stays the same and the
  // model's prompt cache can still reuse it.
  const names = list => [...list].sort((a, b) => a.id - b.id).map(item => item.name);

  return {
    existingTagNames: names(existingTags),
    existingCorrespondentList: names(existingCorrespondents),
    existingDocumentTypesList: names(existingDocumentTypes),
    ownUserId
  };
}

/**
 * The context to use for the next document. The lists are read once per run,
 * so a tag, correspondent or document type the save just created would stay
 * invisible to the AI for the rest of the run (and, with "use existing data",
 * every document would invent its own variant). When the analysis named
 * anything the lists do not have yet, they are read again. A failed refresh
 * keeps the old lists: the document itself is already saved.
 */
async function refreshContext(context, analysis) {
  const normalize = name => String(name).toLowerCase().trim();
  const isNew = (name, list) => Boolean(name) && !list.some(known => normalize(known) === normalize(name));
  const result = (analysis && analysis.document) || {};
  const namesSomethingNew = (Array.isArray(result.tags) ? result.tags : []).some(tag => isNew(tag, context.existingTagNames))
    || isNew(result.correspondent, context.existingCorrespondentList)
    || isNew(result.document_type, context.existingDocumentTypesList);
  if (!namesSomethingNew) return context;

  try {
    return await collectContext();
  } catch (error) {
    console.error('[ERROR] refreshing tags/correspondents/document types:', error.message);
    return context;
  }
}

/**
 * Run the pipeline over a document list.
 * opts.force re-processes already-processed documents (reprocess-all).
 * opts.dropHistory clears each document's history before it is reprocessed.
 * requestStop() ends the run after the current document.
 * Holds the shared task lock for the duration, so a manual run can never overlap
 * the cron scan or the webhook queue.
 * Returns per-run counters so the caller can report progress.
 */
async function scanAll(documents, opts = {}) {
  if (!taskLock.tryAcquire()) {
    const error = new Error('A processing run is already active');
    error.alreadyRunning = true;
    throw error;
  }
  return runWithHeldLock(documents, opts);
}

/**
 * Same as scanAll, for a caller that already took the lock with
 * taskLock.tryAcquire() — e.g. reprocess-all, which must hold the lock while it
 * resets processing records, before the run starts. Always releases the lock.
 */
async function runWithHeldLock(documents, opts = {}) {
  const stats = {
    kind: opts.kind || 'scan',
    processed: 0,
    skipped: 0,
    failed: 0,
    total: documents.length,
    startedAt: new Date().toISOString()
  };

  currentRun = stats;

  try {
    let context = await collectContext();

    for (const doc of documents) {
      if (stats.stopRequested) {
        stats.stopped = true;
        break;
      }
      try {
        // A reprocess replaces the tags the previous run added: read which
        // those are before dropHistory forgets them.
        const docOpts = opts.force ? { ...opts, previousAiTags: await previousAiTagIds(doc.id) } : opts;

        // Reprocess without history: forget this document's history right
        // before analysing it again (not for the whole list up front), so a
        // stopped run leaves the documents it did not reach untouched.
        if (opts.dropHistory) await documentModel.clearHistory(doc.id);

        const result = await processDocument(
          doc, context.existingTagNames, context.existingCorrespondentList, context.existingDocumentTypesList,
          context.ownUserId, null, docOpts
        );
        if (!result) {
          stats.skipped++;
          continue;
        }

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc, docOpts);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData, docOpts);
        context = await refreshContext(context, analysis);
        stats.processed++;
      } catch (error) {
        stats.failed++;
        console.error(`[ERROR] processing document ${doc.id}:`, error);
      }
    }
  } finally {
    taskLock.release();
    lastRun = stats;
    currentRun = null;
  }

  return stats;
}

/**
 * Ask the active run to stop: it finishes the document it is on and processes
 * no further ones. Returns false when no run is active.
 */
function requestStop() {
  if (!currentRun) return false;
  currentRun.stopRequested = true;
  return true;
}

/** Live + last-run counters for the UI. */
function getRunStatus() {
  return {
    running: taskLock.isRunning(),
    current: currentRun,
    last: lastRun
  };
}

module.exports = {
  processDocument,
  buildUpdateData,
  saveDocumentChanges,
  scanAll,
  runWithHeldLock,
  requestStop,
  getRunStatus,
  getLastRun: () => lastRun,
  collectContext,
  refreshContext,
  REPROCESS_FIELDS,
  taskLock
};
