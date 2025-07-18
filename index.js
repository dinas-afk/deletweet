const { TwitterApi } = require("twitter-api-v2");
const inquirer = require("inquirer");
const cliProgress = require("cli-progress");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

class TweetDeleter {
  constructor() {
    this.client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
    });

    this.tweetsPerBatch = parseInt(process.env.TWEETS_PER_BATCH) || 50;
    this.batchDelayMinutes = parseInt(process.env.BATCH_DELAY_MINUTES) || 15;
    this.deletedTweets = [];
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
      const tweets = await this.client.v2.userTimeline(user.data.id, {
        max_results: maxResults,
        "tweet.fields": ["created_at", "public_metrics"],
      });

      console.log("API Response:", tweets);
      return tweets.data || [];
    } catch (error) {
      if (error.code === 429) {
        console.error("❌ Rate limit exceeded!");
        console.error(`Rate limit: ${error.rateLimit?.limit || 'unknown'} requests`);
        console.error(`Remaining: ${error.rateLimit?.remaining || 0}`);
        
        if (error.rateLimit?.reset) {
          const resetTime = new Date(error.rateLimit.reset * 1000);
          console.error(`Rate limit resets at: ${resetTime.toLocaleString()}`);
          const minutesUntilReset = Math.ceil((resetTime - new Date()) / (1000 * 60));
          console.error(`Wait ${minutesUntilReset} minutes before trying again.`);
        }
        
        console.error("\n💡 Your API access level may be too restricted for this operation.");
        console.error("Consider upgrading to Twitter API v2 Basic or higher for better rate limits.");
      } else {
        console.error("Error fetching tweets:", error.message);
      }
      return [];
    }
  }

  async sleep(minutes) {
    console.log(`⏳ Waiting ${minutes} minutes before next batch...`);
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

  async saveDeletionLog() {
    const logFile = path.join(__dirname, "deleted_tweets.json");
    await fs.writeFile(logFile, JSON.stringify(this.deletedTweets, null, 2));
    console.log(`📝 Deletion log saved to ${logFile}`);
  }
}

async function main() {
  console.log("🐦 Twitter Tweet Deleter");
  console.log("========================\n");

  const deleter = new TweetDeleter();

  // Validate credentials
  if (!(await deleter.validateCredentials())) {
    console.log(
      "Please check your .env file and ensure all credentials are correct."
    );
    process.exit(1);
  }

  // Fetch tweets
  console.log("📥 Fetching your tweets...");
  const tweets = await deleter.fetchUserTweets();

  if (!Array.isArray(tweets) || tweets.length === 0) {
    console.log("No tweets found to delete.");
    process.exit(0);
  }

  console.log(`Found ${tweets.length} tweets to potentially delete.\n`);

  // Show some examples
  console.log("Recent tweets:");
  tweets.slice(0, 5).forEach((tweet, index) => {
    const tweetText = tweet.text || "No text available";
    console.log(`${index + 1}. ${tweetText.substring(0, 100)}...`);
  });

  console.log("\n⚠️  This will permanently delete tweets from your account!");

  const { confirm } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirm",
      message: "Are you sure you want to proceed with deletion?",
      default: false,
    },
  ]);

  if (!confirm) {
    console.log("Operation cancelled.");
    process.exit(0);
  }

  console.log("\n🚀 Starting deletion process...");
  // TODO: Implement deletion logic in next phase
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = TweetDeleter;
