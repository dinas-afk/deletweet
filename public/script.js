let tweets = [];
let selectedTweets = new Set();

// Initialize the application
async function initialize() {
    const btn = document.getElementById('init-btn');
    const statusText = document.getElementById('status-text');
    
    btn.disabled = true;
    btn.textContent = 'Initializing...';
    statusText.textContent = 'Connecting to Twitter API...';
    
    try {
        const response = await fetch('/api/initialize', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            statusText.textContent = '✅ Connected to Twitter API successfully!';
            document.getElementById('load-tweets-btn').disabled = false;
            btn.style.display = 'none';
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        statusText.textContent = `❌ Failed to connect: ${error.message}`;
        btn.disabled = false;
        btn.textContent = 'Retry Initialize';
    }
}

// Load tweets from the API
async function loadTweets() {
    const btn = document.getElementById('load-tweets-btn');
    const statusText = document.getElementById('status-text');
    const tweetsSection = document.getElementById('tweets-section');
    
    btn.disabled = true;
    btn.textContent = 'Loading...';
    statusText.textContent = 'Fetching your tweets...';
    
    try {
        const response = await fetch('/api/tweets');
        const result = await response.json();
        
        if (result.tweets) {
            tweets = result.tweets;
            statusText.textContent = `✅ Loaded ${result.count} tweets successfully!`;
            tweetsSection.style.display = 'block';
            renderTweets();
            btn.style.display = 'none';
        } else {
            throw new Error(result.error || 'Failed to load tweets');
        }
    } catch (error) {
        statusText.textContent = `❌ Failed to load tweets: ${error.message}`;
        btn.disabled = false;
        btn.textContent = 'Retry Loading';
    }
}

// Render tweets in the UI
function renderTweets() {
    const container = document.getElementById('tweets-container');
    
    if (tweets.length === 0) {
        container.innerHTML = '<p>No tweets found to delete.</p>';
        return;
    }
    
    const tweetsHTML = tweets.map(tweet => {
        const createdAt = new Date(tweet.created_at).toLocaleDateString();
        const isSelected = selectedTweets.has(tweet.id);
        
        return `
            <div class="tweet-card ${isSelected ? 'selected' : ''}" onclick="toggleTweet('${tweet.id}')">
                <div class="tweet-text">${escapeHtml(tweet.text)}</div>
                <div class="tweet-meta">
                    <span>📅 ${createdAt}</span>
                    <span>${tweet.public_metrics ? `❤️ ${tweet.public_metrics.like_count} 🔄 ${tweet.public_metrics.retweet_count}` : ''}</span>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = `<div class="tweets-grid">${tweetsHTML}</div>`;
    updateSelectedCount();
}

// Toggle tweet selection
function toggleTweet(tweetId) {
    if (selectedTweets.has(tweetId)) {
        selectedTweets.delete(tweetId);
    } else {
        selectedTweets.add(tweetId);
    }
    renderTweets();
}

// Selection helper functions
function selectAll() {
    selectedTweets = new Set(tweets.map(t => t.id));
    renderTweets();
}

function selectNone() {
    selectedTweets.clear();
    renderTweets();
}

function selectOld() {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    selectedTweets.clear();
    tweets.forEach(tweet => {
        const tweetDate = new Date(tweet.created_at);
        if (tweetDate < oneYearAgo) {
            selectedTweets.add(tweet.id);
        }
    });
    renderTweets();
}

// Update selected count display
function updateSelectedCount() {
    const count = selectedTweets.size;
    document.getElementById('selected-count').textContent = count;
    document.getElementById('delete-btn').disabled = count === 0;
}

// Delete selected tweets
async function deleteSelected() {
    if (selectedTweets.size === 0) return;
    
    const confirmed = confirm(`Are you sure you want to permanently delete ${selectedTweets.size} tweets? This action cannot be undone.`);
    if (!confirmed) return;
    
    const tweetIds = Array.from(selectedTweets);
    
    // Show progress section
    document.getElementById('progress-section').style.display = 'block';
    document.getElementById('total-count').textContent = tweetIds.length;
    
    // Disable delete button
    document.getElementById('delete-btn').disabled = true;
    
    try {
        const response = await fetch('/api/delete-tweets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tweetIds })
        });
        
        const result = await response.json();
        
        if (result.message) {
            // Start polling for progress
            pollDeletionProgress();
        } else {
            throw new Error(result.error || 'Failed to start deletion');
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
        document.getElementById('delete-btn').disabled = false;
    }
}

// Poll deletion progress
async function pollDeletionProgress() {
    try {
        const response = await fetch('/api/deletion-progress');
        const progress = await response.json();
        
        // Update progress bar
        document.getElementById('progress-fill').style.width = `${progress.progress}%`;
        document.getElementById('progress-text').textContent = 
            `Progress: ${progress.stats.deleted + progress.stats.failed}/${progress.stats.total} tweets processed`;
        
        // Update stats
        document.getElementById('deleted-count').textContent = progress.stats.deleted;
        document.getElementById('failed-count').textContent = progress.stats.failed;
        
        if (progress.inProgress) {
            // Continue polling
            setTimeout(pollDeletionProgress, 2000);
        } else {
            // Deletion complete
            document.getElementById('progress-text').textContent = 
                `✅ Deletion complete! ${progress.stats.deleted} deleted, ${progress.stats.failed} failed`;
            
            // Remove deleted tweets from the display
            tweets = tweets.filter(tweet => !selectedTweets.has(tweet.id));
            selectedTweets.clear();
            renderTweets();
            
            // Re-enable delete button
            document.getElementById('delete-btn').disabled = false;
        }
    } catch (error) {
        console.error('Error polling progress:', error);
        setTimeout(pollDeletionProgress, 5000); // Retry in 5 seconds
    }
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Check initial status
    try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        if (status.initialized) {
            document.getElementById('status-text').textContent = '✅ Already connected to Twitter API';
            document.getElementById('init-btn').style.display = 'none';
            document.getElementById('load-tweets-btn').disabled = false;
        }
    } catch (error) {
        console.error('Error checking status:', error);
    }
});