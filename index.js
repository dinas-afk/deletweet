const { TwitterApi } = require("twitter-api-v2");
const cliProgress = require("cli-progress");
const fs = require("fs").promises;
const path = require("path");
const readline = require("readline");
require("dotenv").config();

class TweetDeleter {
  constructor() {
    this.client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
    });

    // Free tier conservative settings
    this.tweetsPerBatch = parseInt(process.env.TWEETS_PER_BATCH) || 5; // Much smaller batches
    this.batchDelayMinutes = parseInt(process.env.BATCH_DELAY_MINUTES) || 90; // 90 minutes between batches
    this.deletedTweets = [];
    this.maxDeletionsPerDay = 15; // Conservative daily limit for free tier
  }

  async validateCredentials() {
    try {
      const user = await this.client.v2.me();
      console.log(`✅ Connected as @${user.data.username}`);
      return true;
    } catch (error) {
      console.error("❌ Failed to authenticate:", error.message);
      return false;
    }
  }

  async fetchUserTweets(maxResults = 100) {
    try {
      const user = await this.client.v2.me();
      
      // Free tier: much smaller request to avoid hitting monthly post cap
      const freetierMaxResults = Math.min(maxResults, 10); // Very conservative
      
      const tweets = await this.client.v2.userTimeline(user.data.id, {
        max_results: freetierMaxResults,
        "tweet.fields": ["created_at", "public_metrics"]
      });

      const allTweets = tweets._realData?.data || [];
      console.log(`📊 Fetched ${allTweets.length} tweets`);
      
      // Filter out replies (tweets that start with @) and retweets
      const originalTweets = allTweets.filter(tweet => {
        return !tweet.text.startsWith('@') && !tweet.text.startsWith('RT @');
      });
      
      console.log(`📊 ${originalTweets.length} original posts after filtering`);
      
      // Limit to daily deletion quota for free tier
      const limitedTweets = originalTweets.slice(0, this.maxDeletionsPerDay);
      if (limitedTweets.length < originalTweets.length) {
        console.log(`⚠️  Limited to ${this.maxDeletionsPerDay} tweets due to Free tier daily limits`);
      }
      
      return limitedTweets;
    } catch (error) {
      if (error.code === 429) {
        console.error("❌ Rate limit exceeded!");
        
        if (error.rateLimit?.reset) {
          const resetTime = new Date(error.rateLimit.reset * 1000);
          const minutesUntilReset = Math.ceil((resetTime - new Date()) / (1000 * 60));
          console.error(`⏰ Rate limit resets in ${minutesUntilReset} minutes`);
        }
        
        console.error("\n💡 Free tier limits are very restrictive. Consider upgrading at: https://developer.twitter.com/en/portal/dashboard");
      } else {
        console.error("❌ Error fetching tweets:", error.message);
      }
      return [];
    }
  }

  async sleep(minutes) {
    const progressBar = new cliProgress.SingleBar({
      format: "Waiting |{bar}| {percentage}% | {value}/{total} minutes",
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
    });

    progressBar.start(minutes, 0);

    for (let i = 0; i < minutes; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60000)); // 1 minute
      progressBar.update(i + 1);
    }

    progressBar.stop();
  }

  async deleteTweet(tweetId) {
    try {
      const result = await this.client.v2.deleteTweet(tweetId);
      return { success: true, id: tweetId };
    } catch (error) {
      if (error.code === 429) {
        throw error; // Re-throw rate limit errors to handle at batch level
      }
      console.error(`❌ Failed to delete tweet ${tweetId}:`, error.message);
      return { success: false, id: tweetId, error: error.message };
    }
  }

  async deleteTweetsInBatches(tweets) {
    const totalTweets = tweets.length;
    let deletedCount = 0;
    let failedCount = 0;

    console.log(`📊 Processing ${totalTweets} tweets (Free tier: max ${this.maxDeletionsPerDay}/day)`);
    
    for (let i = 0; i < tweets.length; i += this.tweetsPerBatch) {
      const batch = tweets.slice(i, i + this.tweetsPerBatch);
      const batchNumber = Math.floor(i / this.tweetsPerBatch) + 1;
      const totalBatches = Math.ceil(tweets.length / this.tweetsPerBatch);

      console.log(`\n🔄 Batch ${batchNumber}/${totalBatches} (${batch.length} tweets)`);

      const progressBar = new cliProgress.SingleBar({
        format: "Deleting |{bar}| {percentage}% | {value}/{total} tweets",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
      });

      progressBar.start(batch.length, 0);

      for (let j = 0; j < batch.length; j++) {
        const tweet = batch[j];
        try {
          const result = await this.deleteTweet(tweet.id);
          
          if (result.success) {
            deletedCount++;
            this.deletedTweets.push({
              id: tweet.id,
              text: tweet.text,
              created_at: tweet.created_at,
              deleted_at: new Date().toISOString()
            });
          } else {
            failedCount++;
          }

          progressBar.update(j + 1);
          
          // Much longer delay between individual deletions for free tier
          await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
          
        } catch (error) {
          if (error.code === 429) {
            progressBar.stop();
            console.log(`\n⚠️  Rate limit hit - waiting for reset...`);
            
            if (error.rateLimit?.reset) {
              const resetTime = new Date(error.rateLimit.reset * 1000);
              const minutesUntilReset = Math.ceil((resetTime - new Date()) / (1000 * 60));
              console.log(`⏰ Rate limit resets in ${minutesUntilReset} minutes`);
              await this.sleep(minutesUntilReset + 5); // Add 5 minute buffer
            } else {
              await this.sleep(24 * 60); // Wait 24 hours for daily reset
            }
            
            // Retry this tweet
            j--;
            progressBar.start(batch.length, j + 1);
            continue;
          }
          
          failedCount++;
          progressBar.update(j + 1);
        }
      }

      progressBar.stop();

      // Wait between batches (except for the last batch)
      if (i + this.tweetsPerBatch < tweets.length) {
        await this.sleep(this.batchDelayMinutes);
      }
    }

    console.log(`\n✅ Completed: ${deletedCount} deleted, ${failedCount} failed`);
    
    if (deletedCount >= this.maxDeletionsPerDay) {
      console.log(`⚠️  Daily limit reached. Wait 24 hours before running again.`);
    }
    
    return { deleted: deletedCount, failed: failedCount };
  }

  async saveDeletionLog() {
    const logFile = path.join(__dirname, "deleted_tweets.json");
    await fs.writeFile(logFile, JSON.stringify(this.deletedTweets, null, 2));
    console.log(`📝 Log saved: ${logFile}`);
  }

  async askConfirmation(message) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(`${message} (y/N): `, (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }
}

async function main() {
  console.log("🐦 Twitter Tweet Deleter");
  console.log("========================\n");

  const deleter = new TweetDeleter();

  // Validate credentials
  if (!(await deleter.validateCredentials())) {
    console.log("Please check your .env file and ensure all credentials are correct.");
    process.exit(1);
  }

  console.log("\n⚠️  FREE TIER LIMITATIONS:");
  console.log("   • Only 17 tweet deletions per 24 hours");
  console.log("   • Process will be VERY slow (5+ minutes between deletions)");
  console.log("   • Consider upgrading at: https://developer.twitter.com/en/portal/dashboard\n");

  // Fetch tweets
  console.log("📥 Fetching your tweets...");
  const tweets = await deleter.fetchUserTweets();

  if (!Array.isArray(tweets) || tweets.length === 0) {
    console.log("No tweets found to delete.");
    process.exit(0);
  }

  console.log(`\nFound ${tweets.length} tweets to delete:`);
  tweets.slice(0, 5).forEach((tweet, index) => {
    const tweetText = tweet.text || "No text available";
    console.log(`${index + 1}. ${tweetText.substring(0, 80)}...`);
  });

  console.log("\n⚠️  This will permanently delete tweets from your account!");

  const confirm = await deleter.askConfirmation("Are you sure you want to proceed?");

  if (!confirm) {
    console.log("Operation cancelled.");
    process.exit(0);
  }

  console.log("\n🚀 Starting deletion process...");
  
  const results = await deleter.deleteTweetsInBatches(tweets);
  
  // Save deletion log
  await deleter.saveDeletionLog();
  
  console.log("\n🎉 Process completed!");
  console.log(`📈 Summary: ${results.deleted} deleted, ${results.failed} failed`);
  
  if (results.deleted >= deleter.maxDeletionsPerDay) {
    console.log(`⏰ Daily limit reached. Wait 24 hours before running again.`);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = TweetDeleter;
