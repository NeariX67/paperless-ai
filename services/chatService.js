// services/chatService.js
const PaperlessService = require('./paperlessService');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const { OpenAI } = require('openai');
const providerRegistry = require('./providerRegistry');

class ChatService {
  constructor() {
    this.chats = new Map(); // Stores chat histories: documentId -> messages[]
    this.tempDir = path.join(os.tmpdir(), 'paperless-chat');
    
    // Create temporary directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Downloads the original file from Paperless
   * @param {string} documentId - The ID of the document
   * @returns {Promise<{filePath: string, filename: string, mimeType: string}>}
   */
  async downloadDocument(documentId) {
    try {
      const document = await PaperlessService.getDocument(documentId);
      const tempFilePath = path.join(this.tempDir, `${documentId}_${document.original_filename}`);
      
      // Create download stream
      const response = await PaperlessService.client.get(`/documents/${documentId}/download/`, {
        responseType: 'stream'
      });

      // Save file temporarily
      await pipeline(
        response.data,
        fs.createWriteStream(tempFilePath)
      );

      return {
        filePath: tempFilePath,
        filename: document.original_filename,
        mimeType: document.mime_type
      };
    } catch (error) {
      console.error(`Error downloading document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Initializes a new chat for a document
   * @param {string} documentId - The ID of the document
   */
  async initializeChat(documentId) {
    try {
      // Get document information
      const document = await PaperlessService.getDocument(documentId);
      let documentContent;

      try {
        documentContent = await PaperlessService.getDocumentContent(documentId);
      } catch (error) {
        console.warn('Could not get direct document content, trying file download...', error);
        const { filePath } = await this.downloadDocument(documentId);
        documentContent = await fs.promises.readFile(filePath, 'utf8');
      }

      // Create initial system prompt
      const messages = [
        {
          role: "system",
          content: `You are a helpful assistant for the document "${document.title}". 
                   Use the following document content as context for your responses. 
                   If you don't know something or it's not in the document, please say so honestly.
                   
                   Document content:
                   ${documentContent}`
        }
      ];
      
      this.chats.set(documentId, {
        messages,
        documentTitle: document.title
      });
      
      return {
        documentTitle: document.title,
        initialized: true
      };
    } catch (error) {
      console.error(`Error initializing chat for document ${documentId}:`, error);
      throw error;
    }
  }

  async sendMessageStream(documentId, userMessage, res) {
    try {
      if (!this.chats.has(documentId)) {
        await this.initializeChat(documentId);
      }

      const chatData = this.chats.get(documentId);
      chatData.messages.push({
        role: "user",
        content: userMessage
      });

      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let fullResponse = '';

      const streamWithEntry = async (entry) => {
        const client = providerRegistry.buildClient(entry);
        const stream = await client.chat.completions.create({
          model: entry.model,
          messages: chatData.messages,
          stream: true,
        });

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      };

      const chain = await providerRegistry.getChain();
      const errors = [];
      let attempted = 0;

      for (const entry of chain) {
        if (providerRegistry.isUnhealthy(entry) && attempted > 0) {
          errors.push(`${entry.name}: skipped (unhealthy)`);
          continue;
        }
        attempted++;
        try {
          // Fallback is only possible before any content reached the client;
          // once streaming started the response is already committed.
          if (fullResponse.length > 0) break;
          await streamWithEntry(entry);
          providerRegistry.markSuccess(entry);
          break;
        } catch (error) {
          providerRegistry.markFailure(entry, error.message);
          errors.push(`${entry.name}: ${error.message}`);
          console.error(`[ERROR] chat stream via provider '${entry.name}' failed:`, error.message);
        }
      }

      if (!fullResponse && errors.length && attempted > 0) {
        throw new Error(`All providers failed: ${errors.join(' | ')}`);
      }

      // Add the complete response to chat history
      chatData.messages.push({
        role: "assistant",
        content: fullResponse
      });
      this.chats.set(documentId, chatData);

      // End the stream
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      console.error(`Error in sendMessageStream:`, error);
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }

  getChatHistory(documentId) {
    const chatData = this.chats.get(documentId);
    return chatData ? chatData.messages : [];
  }

  chatExists(documentId) {
    return this.chats.has(documentId);
  }

  async cleanup() {
    try {
      for (const documentId of this.chats.keys()) {
        await this.deleteChat(documentId);
      }
      if (fs.existsSync(this.tempDir)) {
        await fs.promises.rmdir(this.tempDir, { recursive: true });
      }
    } catch (error) {
      console.error('Error cleaning up ChatService:', error);
    }
  }
}

module.exports = new ChatService();
