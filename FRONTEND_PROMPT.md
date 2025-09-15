# Frontend Development Prompt for Colby GitHub Bot

## Project Overview
Build a modern, responsive frontend application that connects to the Colby GitHub Bot API. This frontend should provide an intuitive interface for managing GitHub workflows, monitoring research operations, and interacting with AI-powered code analysis features.

## API Base URL
```
https://gh-bot.hacolby.workers.dev
```

## OpenAPI Specification
The complete API specification is available at:
```
https://gh-bot.hacolby.workers.dev/openapi.json
```

## Core Features to Implement

### 1. Dashboard Overview
- **Real-time Statistics**: Display total commands, active operations, repositories, and best practices
- **Quick Actions**: Buttons to trigger research sweeps, view recent activity
- **Status Indicators**: Visual health status, operation progress bars
- **Recent Activity Feed**: Live updates of recent commands and operations

### 2. Research & Analysis Module
- **Repository Discovery**: Interface to browse discovered repositories
- **Research Results**: Display analyzed repositories with AI summaries
- **Filtering & Search**: Filter by score, category, technology stack
- **Research Controls**: Start/stop research sweeps, view progress
- **Repository Details**: Deep dive into individual repository analysis

### 3. Command Management
- **Command History**: List all executed Colby commands with status
- **Command Filtering**: Filter by repository, author, status, date range
- **Command Details**: View full command execution logs and results
- **Real-time Updates**: Live status updates for running commands

### 4. Best Practices Management
- **Practice Library**: Browse and search code best practices
- **Category Organization**: Group practices by technology, language, or domain
- **Status Management**: Approve, reject, or mark practices as pending
- **Practice Details**: View full descriptions, examples, and implementation guides

### 5. Operations Monitoring
- **Live Operations**: Real-time view of active operations
- **Progress Tracking**: Visual progress bars and status indicators
- **Operation History**: Historical view of completed operations
- **Error Handling**: Display operation errors and retry options

## Technical Requirements

### Frontend Framework
- **Recommended**: React with TypeScript or Vue.js with TypeScript
- **Alternative**: Next.js for SSR capabilities or Svelte for performance
- **Styling**: Tailwind CSS or Material-UI for modern, responsive design

### State Management
- **API State**: React Query/TanStack Query for server state management
- **Local State**: Zustand or Redux Toolkit for application state
- **Real-time Updates**: WebSocket connections or Server-Sent Events for live data

### Key API Endpoints to Implement

#### Health & Status
```typescript
GET /health
// Returns: { ok: boolean }
```

#### Research Operations
```typescript
GET /research/results?min_score=0.6&limit=50
// Returns: { total_projects: number, results: Repository[] }

GET /research/status
// Returns: { status: string, progress: number, current_operation: string }
```

#### Command Management
```typescript
GET /colby/commands?repo=owner/repo&author=username&status=completed&limit=50
// Returns: { commands: Command[] }

GET /colby/best-practices?category=security&status=approved
// Returns: { practices: BestPractice[] }
```

#### Operations Monitoring
```typescript
GET /api/operations
// Returns: { operations: Operation[] }

GET /api/stats
// Returns: { projects: number, commands: number, practices: number, analyses: number, operations: number, repositories: number }
```

### UI/UX Requirements

#### Design System
- **Color Scheme**: Professional blue/gray palette with accent colors for status indicators
- **Typography**: Clean, readable fonts (Inter, Roboto, or system fonts)
- **Icons**: Consistent icon library (Heroicons, Lucide, or Feather)
- **Responsive**: Mobile-first design with breakpoints for tablet and desktop

#### Key UI Components
1. **Navigation**: Sidebar or top navigation with clear section organization
2. **Data Tables**: Sortable, filterable tables for commands, repositories, practices
3. **Cards**: Repository cards with scores, summaries, and action buttons
4. **Modals**: Confirmation dialogs, detailed views, and forms
5. **Progress Indicators**: Loading states, progress bars, and status badges
6. **Charts**: Statistics visualization (optional)

#### User Experience
- **Loading States**: Skeleton screens and loading spinners
- **Error Handling**: User-friendly error messages and retry mechanisms
- **Success Feedback**: Toast notifications and success indicators
- **Keyboard Navigation**: Full keyboard accessibility support
- **Dark Mode**: Optional dark theme toggle

### Real-time Features
- **Live Updates**: WebSocket or polling for real-time data updates
- **Progress Tracking**: Real-time progress bars for long-running operations
- **Notifications**: Toast notifications for completed operations
- **Auto-refresh**: Automatic data refresh for live monitoring

### Data Visualization
- **Repository Scores**: Visual representation of repository analysis scores
- **Command Statistics**: Charts showing command execution trends
- **Operation Progress**: Progress bars and status indicators
- **Research Results**: Interactive repository discovery interface

## Implementation Guidelines

### 1. Project Structure
```
frontend/
├── src/
│   ├── components/          # Reusable UI components
│   ├── pages/              # Page components
│   ├── hooks/              # Custom React hooks
│   ├── services/           # API service layer
│   ├── types/              # TypeScript type definitions
│   ├── utils/              # Utility functions
│   └── styles/             # Global styles and themes
├── public/                 # Static assets
└── package.json
```

### 2. API Service Layer
Create a centralized API service with:
- Type-safe API calls using generated types from OpenAPI spec
- Error handling and retry logic
- Request/response interceptors
- Caching strategies

### 3. State Management
- **Server State**: Use React Query for API data caching and synchronization
- **Client State**: Use Zustand for UI state (modals, filters, user preferences)
- **Real-time State**: WebSocket connections for live updates

### 4. Error Handling
- **API Errors**: Centralized error handling with user-friendly messages
- **Network Errors**: Retry mechanisms and offline indicators
- **Validation Errors**: Form validation with clear error messages

### 5. Performance Optimization
- **Code Splitting**: Lazy load routes and components
- **Memoization**: Use React.memo and useMemo for expensive operations
- **Virtual Scrolling**: For large data tables
- **Image Optimization**: Lazy loading and responsive images

## Development Workflow

### 1. Setup
```bash
# Generate TypeScript types from OpenAPI spec
npx openapi-typescript https://gh-bot.hacolby.workers.dev/openapi.json --output src/types/api.ts

# Install dependencies
npm install @tanstack/react-query zustand axios
npm install -D @types/node
```

### 2. Environment Configuration
```typescript
// src/config/api.ts
export const API_BASE_URL = 'https://gh-bot.hacolby.workers.dev';
export const WS_BASE_URL = 'wss://gh-bot.hacolby.workers.dev'; // if WebSocket support added
```

### 3. Key Hooks to Implement
```typescript
// Custom hooks for API integration
useResearchResults(minScore?: number, limit?: number)
useColbyCommands(filters?: CommandFilters)
useBestPractices(category?: string, status?: string)
useOperations()
useStats()
```

## Testing Requirements

### Unit Tests
- Component rendering and user interactions
- API service functions
- Custom hooks
- Utility functions

### Integration Tests
- API integration with mock data
- User workflows and navigation
- Error handling scenarios

### E2E Tests
- Complete user journeys
- Cross-browser compatibility
- Mobile responsiveness

## Deployment Considerations

### Build Configuration
- **Environment Variables**: API URLs and configuration
- **Build Optimization**: Minification, tree shaking, code splitting
- **Asset Optimization**: Image compression, font loading

### Hosting Options
- **Static Hosting**: Vercel, Netlify, or Cloudflare Pages
- **CDN**: Global content delivery for optimal performance
- **SSL**: HTTPS enforcement and security headers

## Success Criteria

### Functional Requirements
- ✅ All API endpoints properly integrated
- ✅ Real-time updates working correctly
- ✅ Responsive design across all devices
- ✅ Error handling and user feedback
- ✅ Performance under load

### User Experience
- ✅ Intuitive navigation and user flows
- ✅ Fast loading times (< 3 seconds)
- ✅ Accessible design (WCAG 2.1 AA)
- ✅ Smooth animations and transitions

### Technical Quality
- ✅ TypeScript throughout the codebase
- ✅ Comprehensive test coverage (> 80%)
- ✅ Clean, maintainable code structure
- ✅ Performance optimization implemented

## Additional Features (Optional)

### Advanced Features
- **Repository Comparison**: Side-by-side repository analysis
- **Command Templates**: Pre-built command templates for common tasks
- **Export Functionality**: Export data to CSV/JSON formats
- **User Preferences**: Customizable dashboard and settings
- **Search**: Global search across all data types

### Integration Features
- **GitHub Integration**: Direct links to GitHub repositories and PRs
- **Notification System**: Browser notifications for important events
- **Keyboard Shortcuts**: Power user keyboard shortcuts
- **Bulk Operations**: Multi-select and bulk actions

## Getting Started

1. **Clone the repository** and set up the development environment
2. **Generate TypeScript types** from the OpenAPI specification
3. **Set up the project structure** with components, pages, and services
4. **Implement the API service layer** with proper error handling
5. **Build the core components** starting with the dashboard
6. **Add real-time features** for live updates
7. **Implement responsive design** and accessibility features
8. **Add comprehensive testing** and performance optimization
9. **Deploy to production** with proper monitoring

This frontend should provide a powerful, user-friendly interface for managing GitHub workflows and AI-powered code analysis through the Colby GitHub Bot API.
