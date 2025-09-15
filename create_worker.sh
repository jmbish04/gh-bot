# First, make sure you're signed in to GitHub CLI
gh auth status

# Generate a webhook secret
WEBHOOK_SECRET=6502241638
echo "Generated webhook secret: $WEBHOOK_SECRET"

# Create the GitHub App directly via CLI (this bypasses the manifest form issue)
gh api -X POST /user/apps \
  -f name="Colby GitHub Bot" \
  -f description="AI-powered GitHub workflow automation and research." \
  -f url="https://gh-bot.hacolby.workers.dev" \
  -f webhook_url="https://gh-bot.hacolby.workers.dev/github/webhook" \
  -f webhook_secret="$WEBHOOK_SECRET" \
  -f redirect_url="https://gh-bot.hacolby.workers.dev/github/manifest/callback" \
  -f callback_url="https://gh-bot.hacolby.workers.dev/github/oauth/callback" \
  -f public=false \
  -f events='["issues","issue_comment","pull_request","pull_request_review","check_suite","check_run","push"]' \
  -f permissions='{"metadata":"read","contents":"read","issues":"write","pull_requests":"write","checks":"read","actions":"read"}' \
  > app_creation_response.json

# Extract the app details
echo "App created! Check app_creation_response.json for details"
jq -r '.id, .slug, .name, .html_url' app_creation_response.json
