const express = require('express');
const cors = require('cors');
const path = require('path');
const TweetDeleter = require('./index.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let deleter = null;
let deletionInProgress = false;
let deletionStats = { deleted: 0, failed: 0, total: 0 };

// Initialize TweetDeleter
async function initializeDeleter() {
  try {
    deleter = new TweetDeleter();
    const isValid = await deleter.validateCredentials();
    if (!isValid) {
      throw new Error('Invalid Twitter API credentials');
    }
    return true;
  } catch (error) {
    console.error('Failed to initialize:', error.message);
    return false;
  }
}

// API Routes
app.get('/api/status', (req, res) => {
  res.json({ 
    initialized: deleter !== null,
    deletionInProgress,
    stats: deletionStats
  });
});

app.post('/api/initialize', async (req, res) => {
  try {
    const success = await initializeDeleter();
    res.json({ success, message: success ? 'Initialized successfully' : 'Failed to initialize' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/tweets', async (req, res) => {
  try {
    if (!deleter) {
      return res.status(400).json({ error: 'Not initialized' });
    }

    const tweets = await deleter.fetchUserTweets(100); // Max allowed for free tier
    res.json({ tweets, count: tweets.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/delete-tweets', async (req, res) => {
  try {
    if (!deleter) {
      return res.status(400).json({ error: 'Not initialized' });
    }

    if (deletionInProgress) {
      return res.status(400).json({ error: 'Deletion already in progress' });
    }

    const { tweetIds } = req.body;
    if (!tweetIds || !Array.isArray(tweetIds) || tweetIds.length === 0) {
      return res.status(400).json({ error: 'No tweet IDs provided' });
    }

    deletionInProgress = true;
    deletionStats = { deleted: 0, failed: 0, total: tweetIds.length };

    res.json({ message: 'Deletion started', total: tweetIds.length });

    // Start deletion process in background
    processDeletion(tweetIds);

  } catch (error) {
    deletionInProgress = false;
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/deletion-progress', (req, res) => {
  res.json({
    inProgress: deletionInProgress,
    stats: deletionStats,
    progress: deletionStats.total > 0 ? 
      Math.round(((deletionStats.deleted + deletionStats.failed) / deletionStats.total) * 100) : 0
  });
});

async function processDeletion(tweetIds) {
  try {
    // Convert IDs to tweet objects for the existing deletion method
    const tweets = tweetIds.map(id => ({ id }));
    
    // Use existing batch deletion with progress tracking
    for (let i = 0; i < tweets.length; i += deleter.tweetsPerBatch) {
      const batch = tweets.slice(i, i + deleter.tweetsPerBatch);
      
      for (const tweet of batch) {
        try {
          console.log(`🗑️ Attempting to delete tweet: ${tweet.id}`);
          const result = await deleter.deleteTweet(tweet.id);
          console.log(`📊 Deletion result for ${tweet.id}:`, result);
          
          if (result.success) {
            deletionStats.deleted++;
            deleter.deletedTweets.push({
              id: tweet.id,
              deleted_at: new Date().toISOString()
            });
            console.log(`✅ Successfully deleted tweet ${tweet.id}`);
          } else {
            deletionStats.failed++;
            console.log(`❌ Failed to delete tweet ${tweet.id}:`, result.error);
          }
          
          // Small delay between deletions
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          if (error.code === 429) {
            console.log('Rate limit hit, waiting...');
            if (error.rateLimit?.reset) {
              const resetTime = new Date(error.rateLimit.reset * 1000);
              const minutesUntilReset = Math.ceil((resetTime - new Date()) / (1000 * 60));
              await deleter.sleep(minutesUntilReset + 1);
            } else {
              await deleter.sleep(15);
            }
            // Retry this tweet
            i--;
            continue;
          }
          console.error(`Failed to delete tweet ${tweet.id}:`, error.message);
          console.error('Error details:', error);
          deletionStats.failed++;
        }
      }

      // Wait between batches
      if (i + deleter.tweetsPerBatch < tweets.length) {
        await deleter.sleep(deleter.batchDelayMinutes);
      }
    }

    // Save deletion log
    await deleter.saveDeletionLog();
    
  } catch (error) {
    console.error('Deletion process error:', error);
  } finally {
    deletionInProgress = false;
  }
}

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌐 Twitter Tweet Deleter Web Interface`);
  console.log(`📱 Open your browser to: http://localhost:${PORT}`);
  console.log(`🔧 Server running on port ${PORT}`);
});