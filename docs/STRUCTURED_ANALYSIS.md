# Structured Repository Analysis

This update adds structured analysis capabilities to the GitHub bot, providing typed, consistent analysis results in English for any repository.

## Features

### Structured Analysis Schema

The new `StructuredAnalysis` interface provides:

- **purpose**: Clear purpose statement
- **summary**: Detailed functionality summary
- **use_cases**: Array of common use cases
- **repo_kind**: Type classification (frontend, backend, full_stack, library, cli, infra, other)
- **wrangler_bindings**: Detected Cloudflare Workers bindings (KV, D1, R2, etc.)
- **routes**: Discovered API routes/endpoints
- **entrypoints**: Main application entry points
- **notable_deps**: Important dependencies indicating behavior
- **languages**: Programming languages used
- **risk_flags**: Security/risk indicators
- **confidence**: Analysis confidence score (0-1)

### API Endpoints

#### POST `/research/analyze-structured`
Trigger structured analysis for a specific repository.

```bash
curl -X POST "http://localhost:8787/research/analyze-structured" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "cloudflare",
    "repo": "workers-sdk",
    "force": true
  }'
```

#### GET `/research/structured`
Query repositories with structured analysis, with optional filters:

- `binding`: Filter by Cloudflare Workers binding (kv, d1, r2, etc.)
- `kind`: Filter by repository type (frontend, backend, etc.)
- `min_conf`: Minimum confidence threshold

```bash
# Find all repos using D1 database
curl "http://localhost:8787/research/structured?binding=d1&min_conf=0.7"

# Find all backend repositories
curl "http://localhost:8787/research/structured?kind=backend"
```

### English-Only Output

The system ensures all analysis results are in clear, technical English:

- Detects non-English content and translates it
- Uses structured prompts to enforce consistent output format
- Includes post-processing guards to catch mixed-language responses

### Database Schema

#### New Table: `repo_analysis_bindings`
Fast lookup table for binding-based queries:
```sql
CREATE TABLE repo_analysis_bindings (
  repo_full_name TEXT NOT NULL,
  binding TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, binding)
);
```

#### New Column: `structured_json`
Added to `repo_analysis` table to store complete `StructuredAnalysis` objects as JSON.

### Testing

Run the test script to verify functionality:

```bash
./test_structured_analysis.sh
```

This will test both the analysis endpoint and query capabilities.

## Migration

The system supports both legacy and structured analysis modes:

1. **Legacy mode**: Uses existing `analyzeRepoCode()` function
2. **Structured mode**: Uses new `analyzeRepoCodeStructured()` function

Existing data remains untouched. New structured analyses are stored alongside legacy data with additional structured fields.

## Implementation Notes

- **Signal Detection**: Enhanced detection of Wrangler bindings, entry points, and notable dependencies
- **Type Safety**: Full TypeScript interfaces for consistent analysis results
- **Performance**: Indexed binding table allows fast filtering queries
- **Backwards Compatibility**: Legacy analysis endpoints continue to work

The structured analysis provides a reliable foundation for building dashboards, filtering repositories by capabilities, and generating consistent reports across diverse codebases.
