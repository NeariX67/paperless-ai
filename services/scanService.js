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

async function buildUpdateData(analysis, doc) {
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

async function saveDocumentChanges(docId, updateData, analysis, originalData) {
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;

  await Promise.all([
    documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle),
    paperlessService.updateDocument(docId, updateData),
    documentModel.addProcessedDocument(docId, updateData.title),
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
    documentModel.addToHistory(docId, updateData.tags, updateData.title, analysis.document.correspondent)
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

  return {
    existingTagNames: existingTags.map(tag => tag.name),
    existingCorrespondentList: existingCorrespondents.map(c => c.name),
    existingDocumentTypesList: existingDocumentTypes.map(dt => dt.name),
    ownUserId
  };
}

/**
 * Run the pipeline over a document list.
 * opts.force re-processes already-processed documents (reprocess-all).
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
    const { existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId } =
      await collectContext();

    for (const doc of documents) {
      try {
        const result = await processDocument(
          doc, existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId, null, opts
        );
        if (!result) {
          stats.skipped++;
          continue;
        }

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
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
  getRunStatus,
  getLastRun: () => lastRun,
  collectContext,
  taskLock
};
