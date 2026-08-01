# Real-Time Trivia Arena: High-Performance Redis-Powered Backend

This repository contains a production-ready, high-performance backend infrastructure for a real-time competitive quiz game platform. The system leverages advanced Redis data structures, atomic Lua scripting for consistency, and a Server-Sent Events (SSE) pipeline to deliver live, low-latency leaderboard updates.

---

## 1. System Architecture

The application is composed of three primary layers:
1. **Frontend Dashboard**: A premium, responsive single-page dashboard built with glassmorphic CSS styling. It connects to the API endpoints and listens to real-time events via an SSE connection.
2. **API Application Server (Express.js)**: A containerized Node.js service exposing REST API endpoints for user sessions, leaderboards, quiz round submissions, and session admin monitoring.
3. **In-Memory Store & Message Broker (Redis)**: Serves as the central repository for session state, leaderboards, and round metadata. It also facilitates horizontal event broadcasting via Pub/Sub.

```
┌────────────────────────────────────────────────────────┐
│                   Frontend Dashboard                   │
└───────┬───────────────────┬───────────────────▲────────┘
        │                   │                   │
  POST /sessions      POST /game/submit    SSE Stream
        │                   │             (/api/events)
        ▼                   ▼                   │
┌───────────────────────────────────────────────┼────────┐
│                   API Server                  │
│  ┌─────────────────┐     ┌─────────────────┐  │        │
│  │   Main Client   │     │Subscriber Client│  │        │
│  └────────┬────────┘     └────────▲────────┘  │        │
└───────────┼───────────────────────┼───────────┴────────┘
     HSET / EVAL / ZINCRBY      PubSub Messages
            ▼                       │
┌───────────────────────────────────┴────────────────────┐
│                      Redis Server                      │
│  • Hashes: session:{id}, game_round:{id}               │
│  • Sets: user_sessions:{uid}, submissions:{id}         │
│  • Sorted Sets: leaderboard:global                    │
│  • Channels: game-events                               │
└────────────────────────────────────────────────────────┘
```

---

## 2. Redis Key Schema Design

We enforce a consistent `object-type:id:field` convention:

| Data Type | Key Pattern | Example Key | Description |
| :--- | :--- | :--- | :--- |
| **Hash** | `session:{sessionId}` | `session:77a1-432a` | Stores session metadata: `userId`, `ipAddress`, `deviceType`, `createdAt`, `lastActive`. |
| **Set** | `user_sessions:{userId}` | `user_sessions:user-42` | Primary index listing all active `sessionId`s for a specific user. |
| **Sorted Set** | `leaderboard:global` | `leaderboard:global` | Global leaderboard storing all player IDs and scores. |
| **Sorted Set** | `leaderboard:game:{gameId}` | `leaderboard:game:g-10` | Game-specific leaderboard. |
| **Hash** | `game_round:{gameId}:{roundId}` | `game_round:g-10:r-3` | Stores round settings: `endTime`, `correctAnswer`, `points`. |
| **Set** | `submissions:{gameId}:{roundId}` | `submissions:g-10:r-3` | Tracking index containing player IDs who already submitted answers. |

---

## 3. Atomic Lua Scripts (Deep Dive)

Redis Lua scripts are executed atomically by the server. While a script runs, no other Redis command can execute, ensuring complete isolation and consistency.

### Script 1: Session Creation and Login Invalidation
*   **Registration Command**: `invalidateAndCreateSession`
*   **Keys**: `[user_sessions:{userId}, session:{newSessionId}]`
*   **Arguments**: `[newSessionId, userId, createdAt, lastActive, ipAddress, deviceType, ttl]`
*   **Implementation**:
    ```lua
    local userSessionsKey = KEYS[1]
    local newSessionKey = KEYS[2]
    local newSessionId = ARGV[1]
    local userId = ARGV[2]
    local createdAt = ARGV[3]
    local lastActive = ARGV[4]
    local ipAddress = ARGV[5]
    local deviceType = ARGV[6]
    local ttl = ARGV[7]

    -- Fetch and delete all old session hashes
    local oldSessionIds = redis.call('SMEMBERS', userSessionsKey)
    for _, oldId in ipairs(oldSessionIds) do
        redis.call('DEL', 'session:' .. oldId)
    end

    -- Clear the old sessions set
    redis.call('DEL', userSessionsKey)

    -- Create new session hash
    redis.call('HSET', newSessionKey,
        'userId', userId,
        'createdAt', createdAt,
        'lastActive', lastActive,
        'ipAddress', ipAddress,
        'deviceType', deviceType
    )
    redis.call('EXPIRE', newSessionKey, ttl)
    redis.call('SADD', userSessionsKey, newSessionId)
    return 1
    ```

### Script 2: Quiz Game Answer Submission
*   **Registration Command**: `submitAnswer`
*   **Keys**: `[game_round:{gameId}:{roundId}, submissions:{gameId}:{roundId}, leaderboard:global, leaderboard:game:{gameId}]`
*   **Arguments**: `[playerId, answer, currentTime]`
*   **Implementation**:
    ```lua
    local roundKey = KEYS[1]
    local submissionsKey = KEYS[2]
    local globalLeaderboard = KEYS[3]
    local gameLeaderboard = KEYS[4]
    local playerId = ARGV[1]
    local answer = ARGV[2]
    local currentTime = tonumber(ARGV[3])

    -- 1. Check if round exists
    local exists = redis.call('EXISTS', roundKey)
    if exists == 0 then
        return { "ERROR", "ROUND_NOT_FOUND" }
    end

    -- 2. Check if the round is still active (currentTime < endTime)
    local endTime = redis.call('HGET', roundKey, 'endTime')
    if not endTime or currentTime >= tonumber(endTime) then
        return { "ERROR", "ROUND_EXPIRED" }
    end

    -- 3. Check for duplicate submission
    local isMember = redis.call('SISMEMBER', submissionsKey, playerId)
    if isMember == 1 then
        return { "ERROR", "DUPLICATE_SUBMISSION" }
    end

    -- 4. Record submission
    redis.call('SADD', submissionsKey, playerId)

    -- 5. Validate answer and score points
    local correctAnswer = redis.call('HGET', roundKey, 'correctAnswer')
    local pointsToAward = 0
    if correctAnswer == answer then
        local pointsStr = redis.call('HGET', roundKey, 'points')
        pointsToAward = tonumber(pointsStr) or 10
    end

    -- 6. Atomically update score in global and game-specific leaderboards
    local newScore = 0
    if pointsToAward > 0 then
        newScore = tonumber(redis.call('ZINCRBY', globalLeaderboard, pointsToAward, playerId))
        redis.call('ZINCRBY', gameLeaderboard, pointsToAward, playerId)
    else
        local currentScore = redis.call('ZSCORE', globalLeaderboard, playerId)
        if not currentScore then
            redis.call('ZADD', globalLeaderboard, 0, playerId)
            redis.call('ZADD', gameLeaderboard, 0, playerId)
            newScore = 0
        else
            newScore = tonumber(currentScore)
        end
    end

    return { "SUCCESS", tostring(newScore), tostring(pointsToAward) }
    ```

### Why Lua Scripts Over Other Methods?

1.  **Prevention of Race Conditions (Double-Spend Analogy)**:
    In a high-concurrency environment, if two HTTP requests submit answers for the same user concurrently:
    *   *Without Lua (Client-Side Logic)*: Both request threads query `SISMEMBER submissions:round player-1` and receive `0` (false). Both proceed to evaluate the answer, add score, and insert the member. The player gets double points.
    *   *With MULTI/EXEC (Transactions)*: Transactions in Redis are not transactional in a relational sense; they don't support conditional "read-then-write" branches (e.g. "if member doesn't exist, execute these updates"). While `WATCH` can be used to abort on modification, it causes transaction failures under high contention, leading to bad UX and heavy retries.
    *   *With Lua*: The entire check-and-update workflow happens in a single, block-less sweep. The first request grabs the lock, adds the player to the set, and updates the score. The second request is blocked until the first finishes, then inspects `SISMEMBER`, receives `1` (true), and is rejected instantly with `DUPLICATE_SUBMISSION`.
2.  **Reduced Network Round-Trips (Latency Savings)**:
    Answering a question involves reading the round configuration, reading the user's submission state, writing to the submission set, and updating the leaderboard. If performed sequentially from the client, this takes **4 round-trips**. For a client with 20ms ping, that is **80ms**. With Lua, it takes **1 round-trip (20ms)**.
3.  **Perfect Determinism**:
    By passing the server's current timestamp (`currentTime`) as an argument (`ARGV[3]`), we avoid non-deterministic errors (such as calling `TIME` directly inside Lua scripts in older Redis cluster topologies) and keep the script compatible across all Redis versions and cluster configurations.

---

## 4. Setup and Run Instructions

### Prerequisites
*   [Docker Desktop](https://www.docker.com/products/docker-desktop/) (ensure it is running)
*   Docker Compose

### Quick Start
1.  **Clone the Repository** and make sure you are in the project root.
2.  **Initialize Environment File**:
    ```bash
    cp .env.example .env
    ```
3.  **Start Services**:
    ```bash
    docker compose up --build -d
    ```
4.  **Confirm Health Status**:
    Wait a few seconds, then verify the health states of the containers:
    ```bash
    docker ps
    ```
    Alternatively, curl the API health status:
    ```bash
    curl http://localhost:3000/health
    ```

### Accessing the Dashboard
Open your web browser and go to:
*   [http://localhost:3000](http://localhost:3000)

Here you can simulate logins, seed quiz rounds, submit answers, search player ranks, manage active sessions, and observe live updates on the event stream!