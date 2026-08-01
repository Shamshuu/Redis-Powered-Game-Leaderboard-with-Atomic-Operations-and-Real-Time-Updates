import express from 'express';
import { redis } from '../redis.js';

const router = express.Router();

// 1. Get all active sessions for a userId
router.get('/admin/sessions/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const userSessionsKey = `user_sessions:${userId}`;

    // Get all session IDs from the set
    const sessionIds = await redis.smembers(userSessionsKey);
    const activeSessions = [];

    // Retrieve HGETALL for each session ID
    // We can run these in parallel or pipeline for performance
    const pipeline = redis.pipeline();
    sessionIds.forEach(id => {
      pipeline.hgetall(`session:${id}`);
    });
    const results = await pipeline.exec();

    // Track expired session IDs that should be cleaned up from the set
    const expiredSessionIds = [];

    for (let i = 0; i < sessionIds.length; i++) {
      const sessionId = sessionIds[i];
      const [err, sessionData] = results[i];

      if (err) {
        console.error(`Error fetching session ${sessionId}:`, err);
        continue;
      }

      // Check if session exists (HGETALL returns empty object if key does not exist)
      if (sessionData && Object.keys(sessionData).length > 0) {
        activeSessions.push({
          sessionId,
          ipAddress: sessionData.ipAddress || 'unknown',
          lastActive: sessionData.lastActive || sessionData.createdAt || '',
          deviceType: sessionData.deviceType || 'unknown'
        });
      } else {
        expiredSessionIds.push(sessionId);
      }
    }

    // Clean up expired session IDs from the set asynchronously
    if (expiredSessionIds.length > 0) {
      await redis.srem(userSessionsKey, ...expiredSessionIds);
    }

    return res.status(200).json(activeSessions);
  } catch (err) {
    console.error('Error fetching admin user sessions:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. Delete/invalidate a specific session
router.delete('/admin/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const sessionKey = `session:${sessionId}`;

    // Retrieve userId from session to clean up the user_sessions set
    const userId = await redis.hget(sessionKey, 'userId');

    if (userId) {
      // Run deletions atomically using multi/exec
      await redis.multi()
        .del(sessionKey)
        .srem(`user_sessions:${userId}`, sessionId)
        .exec();
    } else {
      // Fallback: delete key if userId wasn't retrieved but key might exist
      await redis.del(sessionKey);
    }

    return res.status(204).end();
  } catch (err) {
    console.error('Error deleting session:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
