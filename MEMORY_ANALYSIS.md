# Redis Memory Analysis Report

This document presents the results of an empirical study on memory usage and performance characteristics of Redis data structures, specifically comparing Redis Hashes (representing user sessions) and Redis Sorted Sets (representing player leaderboards) under different internal encodings: **Listpack (Ziplist)** and **Skiplist**.

---

## 1. Executive Summary

Our experiment populated a Redis 7.4.7 instance with user sessions and a large leaderboard containing 100,000 players. We compared two primary configuration strategies:
1. **Skiplist Mode (Default Limit)**: `zset-max-listpack-entries` was configured to `128` (forcing any set larger than 128 items to convert to a skiplist structure).
2. **Listpack/Ziplist Mode (High Limit)**: `zset-max-listpack-entries` was configured to `150000` (forcing the set to remain packed as a contiguous byte array up to 150,000 entries).

### Metrics Summary Table

| Data Structure / Key | Config / Encoding | Count / Size | Memory Usage (Bytes) | Memory Usage (MB) | Object Encoding | Insertion Time |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Session Hash** | Default (`listpack`) | 5 fields | 224 bytes | < 0.01 MB | `listpack` | < 1 ms |
| **Global Leaderboard** | Skiplist Config | 100k players | 10,169,384 bytes | **9.70 MB** | `skiplist` | **~1.5 seconds** |
| **Global Leaderboard** | Listpack Config | 100k players | 2,097,224 bytes | **2.00 MB** | `listpack` | **~3.5 minutes** |

---

## 2. Structural Memory Consumption Analysis

### Redis Hashes (Session Data)
A single user session represented as a Redis Hash (with fields `userId`, `createdAt`, `lastActive`, `ipAddress`, `deviceType`) requires only **224 bytes** of memory. 
- **Encoding**: Redis automatically encodes small hashes as `listpack`.
- **Optimization**: By storing session fields directly in a Hash instead of a serialized JSON string, we can read/write fields like `lastActive` individually (via `HSET`/`HGET`) without transmitting the entire session object across the network.

### Sorted Sets: Skiplist vs. Listpack

#### 1. Skiplist Encoding (`skiplist` / `hashtable`)
When the leaderboard is allowed to scale under skiplist encoding (the default behavior for larger sets):
- **Memory Consumption**: **9.70 MB**.
- **Underlying Structure**: Redis implements this as a dual structure containing a hash table (for O(1) score lookups by member ID) and a skiplist (a probabilistic multi-level list for fast O(log N) range queries and rank determinations).
- **Overhead**: Every element requires allocation of a hash node, a skiplist node containing an array of forward pointers (averaging 1.33 pointers per node), and the member string itself. This pointer overhead and memory allocation padding accounts for the larger memory footprint.

#### 2. Listpack Encoding (`listpack`)
When we force the leaderboard to remain in listpack format by increasing `zset-max-listpack-entries` to 150k:
- **Memory Consumption**: **2.00 MB**.
- **Underlying Structure**: A listpack is a single, contiguous byte array. Elements (members and scores) are stored sequentially.
- **Overhead**: There are **zero pointers** and zero additional memory allocations per node. The structure is packed contiguously in memory, yielding a **~79.4% memory savings** compared to skiplist.

---

## 3. The CPU vs. Memory Trade-Off

While listpack is highly memory-efficient, it introduces a severe CPU bottleneck for insertions and updates:

1. **Skiplist Insertion Speed**: **~1.5 seconds** to load 100,000 players.
   - **Reasoning**: Inserting an item into a skiplist is an **O(log N)** operation. The process involves traversing forward pointers at higher levels and updating a few pointers at the insertion spot. There are no elements to shift in memory.
   
2. **Listpack Insertion Speed**: **~3.5 minutes** (210 seconds) to load 100,000 players.
   - **Reasoning**: A listpack is stored as a contiguous block of memory. To maintain sorted order:
     - Redis must search linearly through the array (which is **O(N)**).
     - Once the correct spot is found, Redis must perform a `realloc` and shift all subsequent elements forward in memory (which is also **O(N)**).
     - Running this 100,000 times consecutively results in **O(N²)** total operations, leading to extreme CPU usage and blocking the Redis single-threaded event loop.

---

## 4. Production Recommendations

1. **Keep the Defaults (`zset-max-listpack-entries 128` or `512`)**:
   For any high-throughput gaming system where players' scores are updated in real time (e.g. via `ZINCRBY`), forcing listpack encoding for large datasets will completely stall the database. Under load, this would lead to high latency and timeouts.
   
2. **Use Hashes for Session Storage**:
   Hashes naturally stay under the listpack threshold (default `hash-max-listpack-entries 512`) and require very little memory (~224 bytes per user). This makes Redis an exceptional session store, capable of holding millions of active sessions with a very small memory footprint.
