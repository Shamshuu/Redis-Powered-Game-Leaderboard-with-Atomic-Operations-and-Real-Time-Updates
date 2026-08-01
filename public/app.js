// API Base URL (relative since we serve from the same Express instance)
const API_BASE = '/api';

// State management
let eventSource = null;
let previousScores = {}; // To track changes and flash updates

// Initialize application on load
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  initSSE();
  loadLeaderboard();

  // Event Listeners
  document.getElementById('topCount').addEventListener('change', loadLeaderboard);
  document.getElementById('btnSearchPlayer').addEventListener('click', searchPlayerStats);
  document.getElementById('btnLogin').addEventListener('click', handleLogin);
  document.getElementById('btnSeedRound').addEventListener('click', handleSeedRound);
  document.getElementById('btnSubmitAnswer').addEventListener('click', handleSubmitAnswer);
  document.getElementById('btnGetSessions').addEventListener('click', handleAdminGetSessions);
});

// Setup simple Tab navigation
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs & hide all content
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

      // Add active to current & show matching content
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      document.getElementById(targetId).classList.remove('hidden');
    });
  });
}

// Server-Sent Events (SSE) Connection
function initSSE() {
  const statusBadge = document.getElementById('systemStatus');
  const statusText = statusBadge.querySelector('.status-text');

  if (eventSource) {
    eventSource.close();
  }

  // Connect to the Express SSE stream
  eventSource = new EventSource(`${API_BASE}/events`);

  eventSource.onopen = () => {
    statusBadge.classList.add('connected');
    statusText.textContent = 'Live Connected';
    addTickerItem('SSE connection established successfully.', 'system');
  };

  eventSource.onerror = (e) => {
    statusBadge.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    addTickerItem('SSE connection lost. Reconnecting...', 'system');
  };

  // Custom event broadcasted from Pub/Sub
  eventSource.addEventListener('leaderboard_updated', (event) => {
    try {
      const data = JSON.parse(event.data);
      addTickerItem(`Player <b>${data.playerId}</b> score updated to <b>${data.newScore}</b>!`, 'score-update');
      
      // Auto refresh leaderboard
      loadLeaderboard();
      
      // If we are currently searching for this player, update their stats view too
      const searchedPlayerId = document.getElementById('searchPlayerId').value.trim();
      if (searchedPlayerId === data.playerId) {
        searchPlayerStats();
      }
    } catch (err) {
      console.error('Error parsing SSE event data:', err);
    }
  });
}

// Helper to append updates into ticker
function addTickerItem(message, type = '') {
  const ticker = document.getElementById('eventTicker');
  const item = document.createElement('div');
  item.className = `ticker-item ${type}`;
  
  const time = new Date().toLocaleTimeString();
  item.innerHTML = `<span class="ticker-time" style="color: var(--text-muted); font-size: 11px; margin-right: 8px;">[${time}]</span>${message}`;
  
  ticker.appendChild(item);
  ticker.scrollTop = ticker.scrollHeight;
  
  // Keep last 40 items only to prevent memory leak on frontend
  while (ticker.children.length > 40) {
    ticker.removeChild(ticker.firstChild);
  }
}

// Fetch and display global leaderboard top list
async function loadLeaderboard() {
  const listContainer = document.getElementById('leaderboardList');
  const count = document.getElementById('topCount').value;

  try {
    const res = await fetch(`${API_BASE}/leaderboard/top/${count}`);
    if (!res.ok) throw new Error('Failed to load leaderboard data');
    
    const players = await res.json();
    
    if (players.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">Leaderboard is empty. Seed some scores!</div>';
      return;
    }

    const currentScoresMap = {};
    listContainer.innerHTML = '';
    
    players.forEach(player => {
      currentScoresMap[player.playerId] = player.score;
      const hasChanged = previousScores[player.playerId] !== undefined && previousScores[player.playerId] !== player.score;

      const row = document.createElement('div');
      row.className = `leaderboard-row rank-${player.rank} ${hasChanged ? 'score-updated' : ''}`;
      
      row.innerHTML = `
        <div><span class="rank-badge">${player.rank}</span></div>
        <div class="player-name" title="${player.playerId}">${player.playerId}</div>
        <div class="player-score">${player.score}</div>
      `;
      listContainer.appendChild(row);
    });

    // Update historical cache
    previousScores = currentScoresMap;
  } catch (err) {
    console.error(err);
    listContainer.innerHTML = `<div class="empty-state" style="color: var(--danger)">Error loading leaderboard.</div>`;
  }
}

// Search specific player details & rank context
async function searchPlayerStats() {
  const playerId = document.getElementById('searchPlayerId').value.trim();
  const panel = document.getElementById('playerStatsResult');

  if (!playerId) {
    alert('Please enter a player ID.');
    return;
  }

  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="loading-spinner">Querying Redis...</div>';

  try {
    const res = await fetch(`${API_BASE}/leaderboard/player/${playerId}`);
    if (res.status === 404) {
      panel.innerHTML = `<div class="empty-state" style="color: var(--danger)">Player "${playerId}" not found on the leaderboard.</div>`;
      return;
    }
    if (!res.ok) throw new Error('Server error');

    const stats = await res.json();

    let html = `
      <div class="stat-grid">
        <div class="stat-box">
          <div class="value">${stats.score}</div>
          <div class="label">Total Score</div>
        </div>
        <div class="stat-box">
          <div class="value">#${stats.rank}</div>
          <div class="label">Global Rank</div>
        </div>
      </div>
      <div class="stat-box" style="margin-top:-8px;">
        <div class="value">${stats.percentile}%</div>
        <div class="label">Leaderboard Percentile</div>
      </div>
    `;

    // Add nearby players list
    html += `
      <div class="nearby-section">
        <h3>Nearby Competitors</h3>
    `;

    // Above players (ranks R-2, R-1)
    if (stats.nearbyPlayers.above && stats.nearbyPlayers.above.length > 0) {
      stats.nearbyPlayers.above.forEach(p => {
        html += `
          <div class="nearby-row other">
            <span style="font-weight:bold;">#${p.rank}</span>
            <span class="player-name" style="margin-left: 8px;">${p.playerId}</span>
            <span style="text-align:right; font-weight:800; color:var(--text-muted);">${p.score}</span>
          </div>
        `;
      });
    }

    // Current player itself
    html += `
      <div class="nearby-row self">
        <span style="font-weight:bold; color:var(--accent-color);">#${stats.rank}</span>
        <span class="player-name" style="margin-left: 8px; font-weight:bold; color:var(--accent-color);">${stats.playerId} (You)</span>
        <span style="text-align:right; font-weight:800; color:var(--accent-color);">${stats.score}</span>
      </div>
    `;

    // Below players (ranks R+1, R+2)
    if (stats.nearbyPlayers.below && stats.nearbyPlayers.below.length > 0) {
      stats.nearbyPlayers.below.forEach(p => {
        html += `
          <div class="nearby-row other">
            <span style="font-weight:bold;">#${p.rank}</span>
            <span class="player-name" style="margin-left: 8px;">${p.playerId}</span>
            <span style="text-align:right; font-weight:800; color:var(--text-muted);">${p.score}</span>
          </div>
        `;
      });
    }

    html += `</div>`;
    panel.innerHTML = html;
  } catch (err) {
    console.error(err);
    panel.innerHTML = `<div class="empty-state" style="color: var(--danger)">Error looking up player stats.</div>`;
  }
}

// Simulator: Atomic User Login
async function handleLogin() {
  const userId = document.getElementById('loginUserId').value.trim();
  const ipAddress = document.getElementById('loginIp').value.trim();
  const deviceType = document.getElementById('loginDevice').value;
  const resultBox = document.getElementById('loginResult');

  if (!userId) {
    alert('User ID is required');
    return;
  }

  resultBox.classList.remove('hidden');
  resultBox.className = 'result-box';
  resultBox.textContent = 'Processing login (invalidating old sessions)...';

  try {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ipAddress, deviceType })
    });

    const data = await res.json();
    if (res.ok) {
      resultBox.classList.add('success');
      resultBox.textContent = JSON.stringify(data, null, 2);
      
      // Auto-update admin monitor input to this userId for easy navigation
      document.getElementById('adminUserId').value = userId;
      handleAdminGetSessions();
    } else {
      resultBox.classList.add('error');
      resultBox.textContent = `Error ${res.status}: ${data.error || 'Server error'}`;
    }
  } catch (err) {
    resultBox.classList.add('error');
    resultBox.textContent = `Connection failed: ${err.message}`;
  }
}

// Simulator: Seed Game Round
async function handleSeedRound() {
  const gameId = document.getElementById('roundGameId').value.trim();
  const roundId = document.getElementById('roundId').value.trim();
  const duration = parseInt(document.getElementById('roundDuration').value, 10);
  const points = parseInt(document.getElementById('roundPoints').value, 10);
  const correctAnswer = document.getElementById('roundCorrectAnswer').value.trim();
  const resultBox = document.getElementById('seedResult');

  if (!gameId || !roundId || !correctAnswer || isNaN(duration) || isNaN(points)) {
    alert('Please fill out all fields with valid values.');
    return;
  }

  resultBox.classList.remove('hidden');
  resultBox.className = 'result-box';
  resultBox.textContent = 'Seeding round state in Redis...';

  // Compute Unix epoch seconds for expiration window
  const endTime = Math.floor(Date.now() / 1000) + duration;

  try {
    const res = await fetch(`${API_BASE}/game/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, roundId, endTime, correctAnswer, points })
    });

    const data = await res.json();
    if (res.ok) {
      resultBox.classList.add('success');
      resultBox.textContent = JSON.stringify(data, null, 2);
      
      // Autofill submit fields
      document.getElementById('submitGameId').value = gameId;
      document.getElementById('submitRoundId').value = roundId;
      document.getElementById('submitAnswer').value = correctAnswer;
    } else {
      resultBox.classList.add('error');
      resultBox.textContent = `Error ${res.status}: ${data.error || 'Server error'}`;
    }
  } catch (err) {
    resultBox.classList.add('error');
    resultBox.textContent = `Connection failed: ${err.message}`;
  }
}

// Simulator: Submit Answer
async function handleSubmitAnswer() {
  const gameId = document.getElementById('submitGameId').value.trim();
  const roundId = document.getElementById('submitRoundId').value.trim();
  const playerId = document.getElementById('submitPlayerId').value.trim();
  const answer = document.getElementById('submitAnswer').value.trim();
  const resultBox = document.getElementById('submitResult');

  if (!gameId || !roundId || !playerId || !answer) {
    alert('Please fill out all answer submission fields.');
    return;
  }

  resultBox.classList.remove('hidden');
  resultBox.className = 'result-box';
  resultBox.textContent = 'Submitting answer via atomic Lua transaction...';

  try {
    const res = await fetch(`${API_BASE}/game/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, roundId, playerId, answer })
    });

    const data = await res.json();
    if (res.ok) {
      resultBox.classList.add('success');
      resultBox.textContent = JSON.stringify(data, null, 2);
    } else {
      resultBox.classList.add('error');
      resultBox.textContent = JSON.stringify(data, null, 2);
    }
  } catch (err) {
    resultBox.classList.add('error');
    resultBox.textContent = `Connection failed: ${err.message}`;
  }
}

// Admin Panel: Get all sessions for a user
async function handleAdminGetSessions() {
  const userId = document.getElementById('adminUserId').value.trim();
  const container = document.getElementById('adminSessionsList');

  if (!userId) {
    alert('Please enter a User ID.');
    return;
  }

  container.innerHTML = '<div class="loading-spinner">Retrieving sessions from Redis...</div>';

  try {
    const res = await fetch(`${API_BASE}/admin/sessions/user/${userId}`);
    if (!res.ok) throw new Error('Failed to query sessions');

    const sessions = await res.json();

    if (sessions.length === 0) {
      container.innerHTML = '<div class="empty-state">No active sessions found in Redis.</div>';
      return;
    }

    container.innerHTML = '';
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item';
      
      const lastActiveDate = new Date(session.lastActive).toLocaleString();

      item.innerHTML = `
        <div class="session-info">
          <span class="session-id" title="${session.sessionId}">ID: ${session.sessionId.substring(0, 18)}...</span>
          <span class="session-meta">IP: ${session.ipAddress} | Dev: ${session.deviceType}</span>
          <span class="session-meta" style="font-size:10px;">Active: ${lastActiveDate}</span>
        </div>
        <button class="btn btn-danger" onclick="deleteSession('${session.sessionId}', '${userId}')">Delete</button>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="empty-state" style="color: var(--danger)">Error querying user sessions.</div>`;
  }
}

// Admin Panel: Delete a session
async function deleteSession(sessionId, userId) {
  if (!confirm(`Are you sure you want to delete session:\n${sessionId}?`)) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/admin/sessions/${sessionId}`, {
      method: 'DELETE'
    });

    if (res.status === 204) {
      addTickerItem(`Session <b>${sessionId.substring(0,8)}...</b> invalidated by administrator.`, 'system');
      // Refresh list
      handleAdminGetSessions();
    } else {
      alert('Failed to delete session key from Redis.');
    }
  } catch (err) {
    console.error(err);
    alert('Failed to execute session delete request.');
  }
}
window.deleteSession = deleteSession; // Expose to global scope for button onclick
