import express from 'express';
import { redis } from '../redis.js';

const router = express.Router();

// Helper to parse Redis WITHSCORES response into objects
function parseZrevrangeResult(result, startRank) {
  const players = [];
  for (let i = 0; i < result.length; i += 2) {
    const playerId = result[i];
    const score = Number(result[i + 1]);
    const rank = startRank + (i / 2);
    players.push({ rank, playerId, score });
  }
  return players;
}

// 1. Submit or update a player's score
router.post('/leaderboard/scores', async (req, res) => {
  try {
    const { playerId, points } = req.body;

    if (!playerId || typeof points !== 'number') {
      return res.status(400).json({ error: 'playerId and points (number) are required' });
    }

    const globalLeaderboardKey = 'leaderboard:global';

    // Atomically increment score
    const newScoreRaw = await redis.zincrby(globalLeaderboardKey, points, playerId);
    const newScore = Number(newScoreRaw);

    // Publish update event to Pub/Sub
    const eventPayload = {
      event: 'leaderboard_updated',
      data: { playerId, newScore }
    };
    await redis.publish('game-events', JSON.stringify(eventPayload));

    return res.status(200).json({
      playerId,
      newScore
    });
  } catch (err) {
    console.error('Error submitting score:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. Get top players
router.get('/leaderboard/top/:count', async (req, res) => {
  try {
    const count = parseInt(req.params.count, 10);
    if (isNaN(count) || count <= 0) {
      return res.status(400).json({ error: 'Invalid count parameter' });
    }

    const globalLeaderboardKey = 'leaderboard:global';

    // Retrieve members and scores
    const result = await redis.zrevrange(globalLeaderboardKey, 0, count - 1, 'WITHSCORES');
    const topPlayers = parseZrevrangeResult(result, 1);

    return res.status(200).json(topPlayers);
  } catch (err) {
    console.error('Error getting top leaderboard:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. Get specific player rank and context
router.get('/leaderboard/player/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;
    const globalLeaderboardKey = 'leaderboard:global';

    // Fetch player's score
    const scoreRaw = await redis.zscore(globalLeaderboardKey, playerId);
    if (scoreRaw === null) {
      return res.status(404).json({ error: `Player ${playerId} not found on the leaderboard` });
    }
    const score = Number(scoreRaw);

    // Fetch total players count and player's rank (0-indexed)
    const [totalPlayers, zeroIndexedRank] = await Promise.all([
      redis.zcard(globalLeaderboardKey),
      redis.zrevrank(globalLeaderboardKey, playerId)
    ]);

    const rank = zeroIndexedRank + 1;

    // Calculate percentile
    // Formula: (1 - (rank - 1) / totalPlayers) * 100
    const percentile = totalPlayers > 0
      ? Number(((1 - (rank - 1) / totalPlayers) * 100).toFixed(2))
      : 100.0;

    // Fetch 2 players above (rank-2 and rank-1)
    const aboveStart = Math.max(0, zeroIndexedRank - 2);
    const aboveStop = zeroIndexedRank - 1;
    let abovePlayers = [];
    if (aboveStop >= aboveStart) {
      const aboveResult = await redis.zrevrange(globalLeaderboardKey, aboveStart, aboveStop, 'WITHSCORES');
      abovePlayers = parseZrevrangeResult(aboveResult, aboveStart + 1);
    }

    // Fetch 2 players below (rank+1 and rank+2)
    const belowStart = zeroIndexedRank + 1;
    const belowStop = zeroIndexedRank + 2;
    let belowPlayers = [];
    const belowResult = await redis.zrevrange(globalLeaderboardKey, belowStart, belowStop, 'WITHSCORES');
    belowPlayers = parseZrevrangeResult(belowResult, belowStart + 1);

    return res.status(200).json({
      playerId,
      score,
      rank,
      percentile,
      nearbyPlayers: {
        above: abovePlayers,
        below: belowPlayers
      }
    });
  } catch (err) {
    console.error('Error getting player leaderboard info:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
