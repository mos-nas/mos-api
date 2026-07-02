const express = require('express');
const router = express.Router();

const containerState = {
  active: false,
  model: null,
  lastHeartbeat: null,
  pendingMessages: [],
  pendingResponses: []
};

/**
 * @swagger
 * tags:
 *   name: LLM
 *   description: LLM Integration and Chat
 *
 * components:
 *   schemas:
 *     LLMStatus:
 *       type: object
 *       properties:
 *         active:
 *           type: boolean
 *           description: Whether LLM container is connected
 *           example: true
 *         model:
 *           type: string
 *           nullable: true
 *           description: Active LLM model name
 *           example: "qwen3.5-9b"
 *         lastHeartbeat:
 *           type: string
 *           nullable: true
 *           format: date-time
 *           description: Last heartbeat timestamp
 *     LLMChatRequest:
 *       type: object
 *       required:
 *         - message
 *       properties:
 *         message:
 *           type: string
 *           description: User message for the LLM
 *           example: "which disks are free?"
 *         context:
 *           type: string
 *           description: Optional conversation context
 *     LLMChatResponse:
 *       type: object
 *       properties:
 *         response:
 *           type: string
 *           description: LLM response
 *           example: "Following disks are available: /dev/sda (1TB)..."
 *         requestId:
 *           type: string
 *           description: Unique request identifier
 *         error:
 *           type: string
 *           nullable: true
 *           description: Error message if processing failed
 */

/**
 * @swagger
 * /llm/status:
 *   get:
 *     summary: Get LLM container status
 *     description: Returns the current status of the LLM interconnect container
 *     tags: [LLM]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: LLM container status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LLMStatus'
 *       401:
 *         description: Unauthorized
 */
router.get('/status', (req, res) => {
  res.json({
    active: containerState.active,
    model: containerState.model,
    lastHeartbeat: containerState.lastHeartbeat
  });
});

/**
 * @swagger
 * /llm/chat:
 *   post:
 *     summary: Send a message to the LLM
 *     description: Sends a chat message to the LLM via the interconnect container
 *     tags: [LLM]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LLMChatRequest'
 *     responses:
 *       200:
 *         description: LLM response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LLMChatResponse'
 *       503:
 *         description: LLM container not available
 *       401:
 *         description: Unauthorized
 */
router.post('/chat', async (req, res) => {
  if (!containerState.active) {
    return res.status(503).json({
      error: 'LLM container is not connected'
    });
  }

  const { message, context } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error: 'Message is required and must be a non-empty string'
    });
  }

  const requestId = generateRequestId();
  containerState.pendingMessages.push({
    id: requestId,
    message: message.trim(),
    context: context || null,
    timestamp: new Date().toISOString()
  });

  try {
    const response = await waitForResponse(requestId, 600000);
    res.json({
      response: response.content,
      requestId: requestId
    });
  } catch (error) {
    containerState.pendingMessages = containerState.pendingMessages.filter(
      m => m.id !== requestId
    );
    res.status(504).json({
      error: error.message || 'LLM response timeout',
      requestId: requestId
    });
  }
});

// Internal: container sends heartbeat here
router.post('/heartbeat', (req, res) => {
  const { model } = req.body || {};
  containerState.active = true;
  containerState.model = model || containerState.model || 'unknown';
  containerState.lastHeartbeat = new Date().toISOString();
  res.json({ status: 'ok' });
});

// Internal: container gets next pending message (long-poll)
router.get('/pending', (req, res) => {
  const checkPending = () => {
    if (containerState.pendingMessages.length > 0) {
      const msg = containerState.pendingMessages.shift();
      return res.json(msg);
    }
    return null;
  };

  if (checkPending()) return;

  const timeout = setTimeout(() => {
    clearInterval(interval);
    res.json({ id: null, message: null });
  }, 30000);

  const interval = setInterval(() => {
    if (checkPending()) {
      clearTimeout(timeout);
      clearInterval(interval);
    }
  }, 1000);
});

// Internal: container posts response here
router.post('/response', (req, res) => {
  const { requestId, content, error } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ error: 'requestId is required' });
  }

  containerState.pendingResponses.push({
    requestId,
    content: content || null,
    error: error || null,
    timestamp: new Date().toISOString()
  });

  res.json({ status: 'ok' });
});

function generateRequestId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `llm_${timestamp}_${random}`;
}

function waitForResponse(requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('LLM response timeout'));
    }, timeoutMs);

    const interval = setInterval(() => {
      const idx = containerState.pendingResponses.findIndex(r => r.requestId === requestId);
      if (idx !== -1) {
        clearTimeout(timeout);
        clearInterval(interval);
        const response = containerState.pendingResponses[idx];
        containerState.pendingResponses.splice(idx, 1);

        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      }
    }, 200);
  });
}

function getLlmStatus() {
  return {
    active: containerState.active,
    model: containerState.model,
    lastHeartbeat: containerState.lastHeartbeat
  };
}

module.exports = router;
module.exports.getLlmStatus = getLlmStatus;
