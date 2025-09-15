# 🤖 GH Bot - AI-Powered GitHub Workflow Automation

A sophisticated Cloudflare Worker that provides AI-powered GitHub workflow automation, repository analysis, and intelligent recommendations with a learning system that adapts to user preferences.

## ✨ Features

### 🔍 Intelligent Repository Explorer
- **Smart Badge Detection**: Automatically identifies technologies like Cloudflare Workers, Apps Script, shadcn/ui, AI/ML, Home Automation, and more
- **AI-Powered Analysis**: Deep repository analysis with insights, strengths, weaknesses, and recommendations
- **Interactive Modal**: Rich modal interface with detailed analysis instead of simple links
- **Quick Actions**: Ready-to-use commands for deployment, cloning, forking, and exploration

### 🧠 Learning System
- **User Feedback**: Thumbs up/down system to learn user preferences
- **KV Storage**: Persistent storage of user preferences and learning data
- **Adaptive Recommendations**: System improves over time based on user interactions
- **Personalized Scoring**: Repositories are scored based on learned preferences

### 🔧 GitHub Integration
- **Webhook Processing**: Handles GitHub webhooks for PR reviews, comments, and labels
- **Repository Discovery**: Automatically discovers and indexes repositories from GitHub App installations
- **AI Analysis**: Comprehensive repository analysis using Workers AI
- **Command Tracking**: Tracks and manages GitHub commands and operations

### 📊 Research & Analytics
- **Repository Research**: Automated research orchestration across multiple repositories
- **Structured Analysis**: Detailed analysis of code patterns, bindings, and architecture
- **Best Practices**: AI-generated best practices and recommendations
- **Risk Assessment**: Identifies potential issues and areas for improvement

## 🏗️ Architecture

### Core Components
- **Main Worker** (`src/index.ts`): Hono-based API with comprehensive routing
- **Durable Objects**: 
  - `ResearchOrchestrator`: Manages repository research and analysis
  - `PrWorkflow`: Handles PR-specific workflows and automation
  - `ProfileScanner`: Scans developer profiles and organizations
- **D1 Database**: Stores projects, analysis results, and operational data
- **KV Storage**: User preferences and learning data
- **Workers AI**: AI-powered analysis and recommendations

### Key Modules
- `badge_detector.ts`: Technology detection and badge generation
- `ai_repo_analyzer.ts`: Comprehensive repository analysis
- `user_preferences.ts`: Learning system and preference management
- `research.ts`: Repository research and discovery
- `github.ts`: GitHub API integration and authentication

## 🚀 Quick Start

### Prerequisites
- Cloudflare Workers account
- GitHub App with appropriate permissions
- Node.js 18+ and pnpm

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/jmbish04/gh-bot.git
   cd gh-bot
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Configure environment variables**
   ```bash
   cp wrangler.jsonc.example wrangler.jsonc
   # Edit wrangler.jsonc with your configuration
   ```

4. **Set up the database**
   ```bash
   pnpm wrangler d1 create gh-bot
   pnpm wrangler d1 execute gh-bot --file=migrations/0001_init_schema.sql
   ```

5. **Deploy to Cloudflare Workers**
   ```bash
   pnpm wrangler deploy
   ```

### Configuration

#### Required Environment Variables
- `GITHUB_APP_ID`: Your GitHub App ID
- `GITHUB_PRIVATE_KEY`: GitHub App private key
- `GITHUB_WEBHOOK_SECRET`: Webhook secret for signature verification
- `CF_ACCOUNT_ID`: Cloudflare account ID
- `CF_API_TOKEN`: Cloudflare API token
- `FRONTEND_AUTH_PASSWORD`: Password for frontend authentication

#### Optional Environment Variables
- `SUMMARY_CF_MODEL`: AI model for summarization (default: @cf/openai/gpt-oss-120b)

## 📁 Project Structure

```
gh-bot/
├── src/                          # Source code
│   ├── modules/                  # Core modules
│   │   ├── badge_detector.ts    # Technology detection
│   │   ├── ai_repo_analyzer.ts  # AI analysis
│   │   ├── user_preferences.ts  # Learning system
│   │   ├── research.ts          # Repository research
│   │   └── ...                  # Other modules
│   ├── do_*.ts                  # Durable Objects
│   ├── routes/                  # API routes
│   └── types/                   # TypeScript types
├── public/                      # Static assets
│   ├── html/                   # HTML templates
│   ├── css/                    # Stylesheets
│   └── js/                     # JavaScript
├── migrations/                  # Database migrations
├── tests/                      # Test files
├── scripts/                    # Deployment and setup scripts
├── config/                     # Configuration files
├── docs/                       # Documentation
├── examples/                   # Example code
└── wrangler.jsonc             # Cloudflare Workers config
```

## 🔧 API Endpoints

### Repository Analysis
- `GET /api/repo/:owner/:repo/analysis` - Get detailed AI analysis
- `POST /api/repo/:owner/:repo/feedback` - Record user feedback

### Research & Discovery
- `POST /research/run` - Start research sweep
- `GET /research/status` - Get research status
- `GET /research/results` - Get research results
- `GET /research/structured` - Get structured analysis

### GitHub Integration
- `POST /github/webhook` - GitHub webhook handler
- `GET /colby/repo/:owner/:repo` - Repository activity

### Operations
- `GET /api/operations` - Live operations
- `GET /api/stats` - System statistics
- `GET /api/recent-activity` - Recent activity

## 🧪 Testing

Run the test suite:
```bash
# Run all tests
pnpm test

# Run specific test categories
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

## 📚 Documentation

- [Deployment Guide](docs/DEPLOYMENT_STATUS.md)
- [API Documentation](docs/API_REFERENCE.md)
- [Configuration Guide](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Cloudflare Workers for the serverless platform
- GitHub for the comprehensive API
- The open-source community for inspiration and contributions

## 📞 Support

- Create an issue for bug reports or feature requests
- Check the [documentation](docs/) for detailed guides
- Review the [troubleshooting guide](docs/TROUBLESHOOTING.md) for common issues

---

**Made with ❤️ using Cloudflare Workers and AI**

