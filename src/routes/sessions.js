import express from 'express';
import crypto from 'crypto';
import { redis } from '../redis.js';

const router = express.Router();

router.post('/sessions', async (req, res) => {
  try {
    const { userId, ipAddress, deviceType } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const ttl = 1800; // 30 minutes in seconds

    const userSessionsKey = `user_sessions:${userId}`;
    const sessionKey = `session:${sessionId}`;

    // Execute the atomic Lua script to delete old sessions and create the new one
    await redis.invalidateAndCreateSession(
      userSessionsKey,
      sessionKey,
      sessionId,
      userId,
      now, // createdAt
      now, // lastActive
      ipAddress || 'unknown',
      deviceType || 'unknown',
      ttl
    );

    return res.status(201).json({ sessionId });
  } catch (err) {
    console.error('Error creating session:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
