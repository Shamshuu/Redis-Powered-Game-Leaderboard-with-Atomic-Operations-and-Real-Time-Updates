import express from 'express';
import { redis } from '../redis.js';

const router = express.Router();

// Admin/Developer helper endpoint to seed/create a game round
router.post('/game/rounds', async (req, res) => {
  try {
    const { gameId, roundId, endTime, correctAnswer, points } = req.body;

    if (!gameId || !roundId || !endTime || !correctAnswer) {
      return res.status(400).json({ error: 'gameId, roundId, endTime, and correctAnswer are required' });
    }

    const roundKey = `game_round:${gameId}:${roundId}`;
    const pointsValue = typeof points === 'number' ? points : 10;

    await redis.hset(roundKey, {
      endTime: String(endTime),
      correctAnswer: String(correctAnswer),
      points: String(pointsValue)
    });

    // Automatically set expiration on the round state key to clean up after round ends (e.g. 1 hour after endTime)
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(3600, parseInt(endTime, 10) - now + 3600);
    await redis.expire(roundKey, ttl);

    return res.status(201).json({
      message: 'Round created successfully',
      gameId,
      roundId,
      endTime,
      correctAnswer,
      points: pointsValue
    });
  } catch (err) {
    console.error('Error seeding round:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Submit a player's answer atomically
router.post('/game/submit', async (req, res) => {
  try {
    const { gameId, roundId, playerId, answer } = req.body;

    if (!gameId || !roundId || !playerId || !answer) {
      return res.status(400).json({ error: 'gameId, roundId, playerId, and answer are required' });
    }

    const roundKey = `game_round:${gameId}:${roundId}`;
    const submissionsKey = `submissions:${gameId}:${roundId}`;
    const globalLeaderboardKey = 'leaderboard:global';
    const gameLeaderboardKey = `leaderboard:game:${gameId}`;

    const currentTime = Math.floor(Date.now() / 1000); // Standard Unix epoch seconds

    // Execute atomic Lua script
    const result = await redis.submitAnswer(
      roundKey,
      submissionsKey,
      globalLeaderboardKey,
      gameLeaderboardKey,
      playerId,
      answer,
      currentTime
    );

    const [status, codeOrScore, pointsAwarded] = result;

    if (status === 'ERROR') {
      if (codeOrScore === 'ROUND_EXPIRED') {
        return res.status(403).json({ status: 'ERROR', code: 'ROUND_EXPIRED' });
      }
      if (codeOrScore === 'DUPLICATE_SUBMISSION') {
        return res.status(400).json({ status: 'ERROR', code: 'DUPLICATE_SUBMISSION' });
      }
      if (codeOrScore === 'ROUND_NOT_FOUND') {
        return res.status(404).json({ status: 'ERROR', code: 'ROUND_NOT_FOUND' });
      }
      return res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: codeOrScore });
    }

    // Success
    const newScore = Number(codeOrScore);
    const pts = Number(pointsAwarded);

    // If points were awarded, publish update event to Pub/Sub
    // Even if no points (wrong answer), we can publish to update live scoreboards if needed. Let's publish all updates.
    const eventPayload = {
      event: 'leaderboard_updated',
      data: { playerId, newScore }
    };
    await redis.publish('game-events', JSON.stringify(eventPayload));

    return res.status(200).json({
      status: 'SUCCESS',
      newScore
    });
  } catch (err) {
    console.error('Error submitting answer:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
